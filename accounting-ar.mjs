// FILE: C:\faris-api\accounting-ar.mjs
// جزء المحاسبة: العملاء→الفواتير→الاعتماد→المقبوضات→الاشتراكات المتكررة→أعمار الذمم المدينة.
// يُركّب من accounting-routes.mjs بعد أن تكون الجداول الأساسية ومحرك القيود جاهزين.

export default function mountAR(app, pool, ctx) {
  const { auth, requireManager, postJournalEntry, reverseJournalEntry, nextDocNumber, auditLog, currentVatRate, getAccountByCode, PeriodClosedError } = ctx;

  const bootstrapDone = (async () => {
    await ctx.bootstrapDone; // ننتظر جداول الأساسات (clients/accounting_accounts) قبل إنشاء ما يعتمد عليها
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS public.invoices (
          id              serial PRIMARY KEY,
          invoice_number  text UNIQUE NOT NULL,
          client_id       integer NOT NULL REFERENCES public.clients(id),
          case_id         integer REFERENCES public.cases(id),
          status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','sent','partially_paid','paid','overdue','cancelled')),
          issue_date      date NOT NULL,
          due_date        date NOT NULL,
          subtotal        numeric(14,2) NOT NULL DEFAULT 0,
          discount_amount numeric(14,2) NOT NULL DEFAULT 0,
          tax_amount      numeric(14,2) NOT NULL DEFAULT 0,
          total           numeric(14,2) NOT NULL DEFAULT 0,
          amount_paid     numeric(14,2) NOT NULL DEFAULT 0,
          currency_code   text NOT NULL DEFAULT 'SAR',
          exchange_rate   numeric(12,6) NOT NULL DEFAULT 1,
          notes           text,
          zatca_uuid      text,
          zatca_hash      text,
          zatca_qr        text,
          created_by      integer REFERENCES public.users(id) ON DELETE SET NULL,
          created_at      timestamptz NOT NULL DEFAULT now(),
          updated_at      timestamptz NOT NULL DEFAULT now()
        )`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS public.invoice_items (
          id             serial PRIMARY KEY,
          invoice_id     integer NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
          service_id     integer REFERENCES public.services(id),
          description    text NOT NULL,
          quantity       numeric(12,2) NOT NULL DEFAULT 1,
          unit_price     numeric(14,2) NOT NULL,
          tax_rate       numeric(5,2) NOT NULL DEFAULT 0,
          line_total     numeric(14,2) NOT NULL,
          line_tax       numeric(14,2) NOT NULL DEFAULT 0,
          cost_center_id integer REFERENCES public.cost_centers(id)
        )`);

      // إشعارات دائن/مدين — بنية مرآة مبسّطة، مرتبطة بفاتورة أصلية
      await client.query(`
        CREATE TABLE IF NOT EXISTS public.credit_notes (
          id                  serial PRIMARY KEY,
          note_number         text UNIQUE NOT NULL,
          original_invoice_id integer NOT NULL REFERENCES public.invoices(id),
          amount              numeric(14,2) NOT NULL CHECK (amount > 0),
          tax_amount          numeric(14,2) NOT NULL DEFAULT 0,
          reason              text,
          issue_date          date NOT NULL,
          created_by          integer REFERENCES public.users(id) ON DELETE SET NULL,
          created_at          timestamptz NOT NULL DEFAULT now()
        )`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS public.debit_notes (
          id                  serial PRIMARY KEY,
          note_number         text UNIQUE NOT NULL,
          original_invoice_id integer NOT NULL REFERENCES public.invoices(id),
          amount              numeric(14,2) NOT NULL CHECK (amount > 0),
          tax_amount          numeric(14,2) NOT NULL DEFAULT 0,
          reason              text,
          issue_date          date NOT NULL,
          created_by          integer REFERENCES public.users(id) ON DELETE SET NULL,
          created_at          timestamptz NOT NULL DEFAULT now()
        )`);

      await client.query(`
        CREATE TABLE IF NOT EXISTS public.subscriptions (
          id                serial PRIMARY KEY,
          client_id         integer NOT NULL REFERENCES public.clients(id),
          service_id        integer REFERENCES public.services(id),
          amount            numeric(14,2) NOT NULL CHECK (amount > 0),
          billing_cycle     text NOT NULL CHECK (billing_cycle IN ('monthly','yearly')),
          start_date        date NOT NULL,
          end_date          date,
          next_invoice_date date NOT NULL,
          status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','ended')),
          created_at        timestamptz NOT NULL DEFAULT now()
        )`);

      await client.query(`
        CREATE TABLE IF NOT EXISTS public.receipts (
          id             serial PRIMARY KEY,
          invoice_id     integer REFERENCES public.invoices(id),
          client_id      integer REFERENCES public.clients(id),
          amount         numeric(14,2) NOT NULL CHECK (amount > 0),
          method         text NOT NULL CHECK (method IN ('cash','bank_transfer','card','other')),
          account_id     integer NOT NULL REFERENCES public.accounting_accounts(id),
          payment_date   date NOT NULL,
          reference      text,
          notes          text,
          created_by     integer REFERENCES public.users(id) ON DELETE SET NULL,
          created_at     timestamptz NOT NULL DEFAULT now()
        )`);

      await client.query("COMMIT");
      console.log("✅ accounting-ar: جداول الفواتير/الإشعارات/الاشتراكات/المقبوضات جاهزة");
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("accounting-ar bootstrap error:", e.message);
    } finally {
      client.release();
    }
  })();

  function invOut(inv, items) {
    return {
      id: inv.id, invoiceNumber: inv.invoice_number, clientId: inv.client_id, caseId: inv.case_id,
      status: inv.status, issueDate: inv.issue_date, dueDate: inv.due_date,
      subtotal: Number(inv.subtotal), discountAmount: Number(inv.discount_amount), taxAmount: Number(inv.tax_amount),
      total: Number(inv.total), amountPaid: Number(inv.amount_paid), notes: inv.notes,
      items: (items || []).map((it) => ({
        id: it.id, serviceId: it.service_id, description: it.description, quantity: Number(it.quantity),
        unitPrice: Number(it.unit_price), taxRate: Number(it.tax_rate), lineTotal: Number(it.line_total), lineTax: Number(it.line_tax),
      })),
    };
  }

  async function computeTotals(items, defaultVat, discountAmount) {
    let subtotal = 0, taxAmount = 0;
    const computed = [];
    for (const it of items) {
      const qty = Number(it.quantity || 1);
      const price = Number(it.unitPrice);
      const rate = it.taxRate !== undefined && it.taxRate !== null ? Number(it.taxRate) : defaultVat;
      const lineTotal = Math.round(qty * price * 100) / 100;
      const lineTax = Math.round(lineTotal * rate) / 100;
      subtotal += lineTotal;
      taxAmount += lineTax;
      computed.push({ ...it, quantity: qty, unitPrice: price, taxRate: rate, lineTotal, lineTax });
    }
    subtotal = Math.round(subtotal * 100) / 100;
    taxAmount = Math.round(taxAmount * 100) / 100;
    const discount = Math.round(Number(discountAmount || 0) * 100) / 100;
    const total = Math.round((subtotal - discount + taxAmount) * 100) / 100;
    return { computed, subtotal, taxAmount, discount, total };
  }

  /* ===================== الفواتير ===================== */
  app.get("/accounting/invoices", auth, requireManager, async (req, res) => {
    try {
      const q = await pool.query(`SELECT * FROM public.invoices ORDER BY created_at DESC LIMIT 500`);
      res.json(q.rows.map((r) => invOut(r)));
    } catch (e) {
      console.error("GET /accounting/invoices:", e);
      res.status(500).json({ error: "server_error" });
    }
  });

  app.get("/accounting/invoices/:id", auth, requireManager, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const inv = await pool.query(`SELECT * FROM public.invoices WHERE id=$1`, [id]);
      if (!inv.rowCount) return res.status(404).json({ error: "not_found" });
      const items = await pool.query(`SELECT * FROM public.invoice_items WHERE invoice_id=$1 ORDER BY id`, [id]);
      res.json(invOut(inv.rows[0], items.rows));
    } catch (e) {
      console.error("GET /accounting/invoices/:id:", e);
      res.status(500).json({ error: "server_error" });
    }
  });

  async function createDraftInvoice(client, { clientId, caseId, issueDate, dueDate, items, discountAmount, notes, userId }) {
    if (!clientId || !Array.isArray(items) || !items.length) throw new Error("بيانات الفاتورة ناقصة");
    const vat = await currentVatRate();
    const { computed, subtotal, taxAmount, discount, total } = await computeTotals(items, vat, discountAmount);
    const invoiceNumber = await nextDocNumber(client, "invoice", "INV");
    const ins = await client.query(
      `INSERT INTO public.invoices (invoice_number, client_id, case_id, status, issue_date, due_date, subtotal, discount_amount, tax_amount, total, created_by)
       VALUES ($1,$2,$3,'draft',$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [invoiceNumber, clientId, caseId || null, issueDate, dueDate, subtotal, discount, taxAmount, total, userId || null]
    );
    const invoice = ins.rows[0];
    for (const it of computed) {
      await client.query(
        `INSERT INTO public.invoice_items (invoice_id, service_id, description, quantity, unit_price, tax_rate, line_total, line_tax, cost_center_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [invoice.id, it.serviceId || null, it.description || "", it.quantity, it.unitPrice, it.taxRate, it.lineTotal, it.lineTax, it.costCenterId || null]
      );
    }
    return invoice;
  }

  app.post("/accounting/invoices", auth, requireManager, async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const invoice = await createDraftInvoice(client, { ...req.body, userId: req.user.id });
      await auditLog(client, { userId: req.user.id, action: "invoice.create_draft", entityType: "invoices", entityId: invoice.id, after: invoice });
      await client.query("COMMIT");
      const items = await pool.query(`SELECT * FROM public.invoice_items WHERE invoice_id=$1`, [invoice.id]);
      res.status(201).json(invOut(invoice, items.rows));
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("POST /accounting/invoices:", e);
      res.status(400).json({ error: e.message || "server_error" });
    } finally {
      client.release();
    }
  });

  app.patch("/accounting/invoices/:id", auth, requireManager, async (req, res) => {
    const client = await pool.connect();
    try {
      const id = Number(req.params.id);
      await client.query("BEGIN");
      const cur = await client.query(`SELECT * FROM public.invoices WHERE id=$1 FOR UPDATE`, [id]);
      if (!cur.rowCount) { await client.query("ROLLBACK"); return res.status(404).json({ error: "not_found" }); }
      if (cur.rows[0].status !== "draft") {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "cannot_edit_non_draft" });
      }
      const vat = await currentVatRate();
      const { computed, subtotal, taxAmount, discount, total } = await computeTotals(req.body.items || [], vat, req.body.discountAmount);
      await client.query(`DELETE FROM public.invoice_items WHERE invoice_id=$1`, [id]);
      for (const it of computed) {
        await client.query(
          `INSERT INTO public.invoice_items (invoice_id, service_id, description, quantity, unit_price, tax_rate, line_total, line_tax, cost_center_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [id, it.serviceId || null, it.description || "", it.quantity, it.unitPrice, it.taxRate, it.lineTotal, it.lineTax, it.costCenterId || null]
        );
      }
      const upd = await client.query(
        `UPDATE public.invoices SET client_id=COALESCE($1,client_id), case_id=$2, issue_date=COALESCE($3,issue_date),
                due_date=COALESCE($4,due_date), subtotal=$5, discount_amount=$6, tax_amount=$7, total=$8, notes=$9, updated_at=now()
          WHERE id=$10 RETURNING *`,
        [req.body.clientId || null, req.body.caseId || null, req.body.issueDate || null, req.body.dueDate || null, subtotal, discount, taxAmount, total, req.body.notes || null, id]
      );
      await auditLog(client, { userId: req.user.id, action: "invoice.update_draft", entityType: "invoices", entityId: id, before: cur.rows[0], after: upd.rows[0] });
      await client.query("COMMIT");
      const items = await pool.query(`SELECT * FROM public.invoice_items WHERE invoice_id=$1`, [id]);
      res.json(invOut(upd.rows[0], items.rows));
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("PATCH /accounting/invoices/:id:", e);
      res.status(400).json({ error: e.message || "server_error" });
    } finally {
      client.release();
    }
  });

  app.delete("/accounting/invoices/:id", auth, requireManager, async (req, res) => {
    const client = await pool.connect();
    try {
      const id = Number(req.params.id);
      await client.query("BEGIN");
      const cur = await client.query(`SELECT * FROM public.invoices WHERE id=$1 FOR UPDATE`, [id]);
      if (!cur.rowCount) { await client.query("ROLLBACK"); return res.status(404).json({ error: "not_found" }); }
      if (cur.rows[0].status !== "draft") {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "only_draft_can_be_deleted" });
      }
      await client.query(`DELETE FROM public.invoices WHERE id=$1`, [id]);
      await auditLog(client, { userId: req.user.id, action: "invoice.delete_draft", entityType: "invoices", entityId: id, before: cur.rows[0] });
      await client.query("COMMIT");
      res.json({ ok: true });
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("DELETE /accounting/invoices/:id:", e);
      res.status(500).json({ error: "server_error" });
    } finally {
      client.release();
    }
  });

  app.post("/accounting/invoices/:id/approve", auth, requireManager, async (req, res) => {
    const client = await pool.connect();
    try {
      const id = Number(req.params.id);
      await client.query("BEGIN");
      const cur = await client.query(`SELECT * FROM public.invoices WHERE id=$1 FOR UPDATE`, [id]);
      if (!cur.rowCount) { await client.query("ROLLBACK"); return res.status(404).json({ error: "not_found" }); }
      const inv = cur.rows[0];
      if (inv.status !== "draft") { await client.query("ROLLBACK"); return res.status(409).json({ error: "already_approved" }); }

      const arAccount = await getAccountByCode(client, "1130");
      const revenueAccount = await getAccountByCode(client, "4100");
      const taxAccount = await getAccountByCode(client, "2200");
      const revenueAmount = Math.round((Number(inv.subtotal) - Number(inv.discount_amount)) * 100) / 100;

      const lines = [{ accountId: arAccount, debit: Number(inv.total), credit: 0 }];
      if (revenueAmount > 0) lines.push({ accountId: revenueAccount, debit: 0, credit: revenueAmount });
      if (Number(inv.tax_amount) > 0) lines.push({ accountId: taxAccount, debit: 0, credit: Number(inv.tax_amount) });

      await postJournalEntry(client, {
        date: inv.issue_date, sourceType: "invoice", sourceId: inv.id,
        description: `اعتماد فاتورة ${inv.invoice_number}`, lines, userId: req.user.id,
      });
      const upd = await client.query(`UPDATE public.invoices SET status='approved', updated_at=now() WHERE id=$1 RETURNING *`, [id]);
      await auditLog(client, { userId: req.user.id, action: "invoice.approve", entityType: "invoices", entityId: id, before: inv, after: upd.rows[0] });
      await client.query("COMMIT");
      res.json(invOut(upd.rows[0]));
    } catch (e) {
      await client.query("ROLLBACK");
      if (e instanceof PeriodClosedError) return res.status(409).json({ error: e.message });
      console.error("POST /accounting/invoices/:id/approve:", e);
      res.status(400).json({ error: e.message || "server_error" });
    } finally {
      client.release();
    }
  });

  app.post("/accounting/invoices/:id/send", auth, requireManager, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const q = await pool.query(`UPDATE public.invoices SET status='sent', updated_at=now() WHERE id=$1 AND status='approved' RETURNING *`, [id]);
      if (!q.rowCount) return res.status(409).json({ error: "must_be_approved_first" });
      res.json(invOut(q.rows[0]));
    } catch (e) {
      console.error("POST /accounting/invoices/:id/send:", e);
      res.status(500).json({ error: "server_error" });
    }
  });

  app.post("/accounting/invoices/:id/cancel", auth, requireManager, async (req, res) => {
    const client = await pool.connect();
    try {
      const id = Number(req.params.id);
      await client.query("BEGIN");
      const cur = await client.query(`SELECT * FROM public.invoices WHERE id=$1 FOR UPDATE`, [id]);
      if (!cur.rowCount) { await client.query("ROLLBACK"); return res.status(404).json({ error: "not_found" }); }
      const inv = cur.rows[0];
      if (Number(inv.amount_paid) > 0) { await client.query("ROLLBACK"); return res.status(409).json({ error: "has_payments_cannot_cancel" }); }
      if (inv.status === "cancelled") { await client.query("ROLLBACK"); return res.status(409).json({ error: "already_cancelled" }); }

      if (inv.status !== "draft") {
        const je = await client.query(`SELECT id FROM public.journal_entries WHERE source_type='invoice' AND source_id=$1`, [id]);
        if (je.rowCount) {
          await reverseJournalEntry(client, je.rows[0].id, { date: new Date().toISOString().slice(0, 10), description: `إلغاء فاتورة ${inv.invoice_number}`, userId: req.user.id });
        }
      }
      const upd = await client.query(`UPDATE public.invoices SET status='cancelled', updated_at=now() WHERE id=$1 RETURNING *`, [id]);
      await auditLog(client, { userId: req.user.id, action: "invoice.cancel", entityType: "invoices", entityId: id, before: inv, after: upd.rows[0] });
      await client.query("COMMIT");
      res.json(invOut(upd.rows[0]));
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("POST /accounting/invoices/:id/cancel:", e);
      res.status(400).json({ error: e.message || "server_error" });
    } finally {
      client.release();
    }
  });

  /* ===================== إشعارات دائن ومدين ===================== */
  app.get("/accounting/credit-notes", auth, requireManager, async (req, res) => {
    try {
      const q = await pool.query(`SELECT * FROM public.credit_notes ORDER BY created_at DESC LIMIT 300`);
      res.json(q.rows);
    } catch (e) { console.error("GET /accounting/credit-notes:", e); res.status(500).json({ error: "server_error" }); }
  });

  app.post("/accounting/credit-notes", auth, requireManager, async (req, res) => {
    const client = await pool.connect();
    try {
      const { originalInvoiceId, amount, taxAmount, reason, issueDate } = req.body || {};
      const amt = Number(amount), tax = Number(taxAmount || 0);
      if (!originalInvoiceId || !Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: "bad_input" });
      await client.query("BEGIN");
      const inv = await client.query(`SELECT * FROM public.invoices WHERE id=$1`, [originalInvoiceId]);
      if (!inv.rowCount) { await client.query("ROLLBACK"); return res.status(404).json({ error: "invoice_not_found" }); }
      const noteNumber = await nextDocNumber(client, "credit_note", "CN");
      const ins = await client.query(
        `INSERT INTO public.credit_notes (note_number, original_invoice_id, amount, tax_amount, reason, issue_date, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [noteNumber, originalInvoiceId, amt, tax, reason || null, issueDate, req.user.id]
      );
      const note = ins.rows[0];
      const arAccount = await getAccountByCode(client, "1130");
      const revenueAccount = await getAccountByCode(client, "4100");
      const taxAccount = await getAccountByCode(client, "2200");
      const lines = [{ accountId: revenueAccount, debit: amt, credit: 0 }, { accountId: arAccount, debit: 0, credit: amt + tax }];
      if (tax > 0) lines.push({ accountId: taxAccount, debit: tax, credit: 0 });
      await postJournalEntry(client, { date: issueDate, sourceType: "credit_note", sourceId: note.id, description: `إشعار دائن ${noteNumber}`, lines, userId: req.user.id });
      await auditLog(client, { userId: req.user.id, action: "credit_note.create", entityType: "credit_notes", entityId: note.id, after: note });
      await client.query("COMMIT");
      res.status(201).json(note);
    } catch (e) {
      await client.query("ROLLBACK");
      if (e instanceof PeriodClosedError) return res.status(409).json({ error: e.message });
      console.error("POST /accounting/credit-notes:", e);
      res.status(400).json({ error: e.message || "server_error" });
    } finally { client.release(); }
  });

  app.get("/accounting/debit-notes", auth, requireManager, async (req, res) => {
    try {
      const q = await pool.query(`SELECT * FROM public.debit_notes ORDER BY created_at DESC LIMIT 300`);
      res.json(q.rows);
    } catch (e) { console.error("GET /accounting/debit-notes:", e); res.status(500).json({ error: "server_error" }); }
  });

  app.post("/accounting/debit-notes", auth, requireManager, async (req, res) => {
    const client = await pool.connect();
    try {
      const { originalInvoiceId, amount, taxAmount, reason, issueDate } = req.body || {};
      const amt = Number(amount), tax = Number(taxAmount || 0);
      if (!originalInvoiceId || !Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: "bad_input" });
      await client.query("BEGIN");
      const inv = await client.query(`SELECT * FROM public.invoices WHERE id=$1`, [originalInvoiceId]);
      if (!inv.rowCount) { await client.query("ROLLBACK"); return res.status(404).json({ error: "invoice_not_found" }); }
      const noteNumber = await nextDocNumber(client, "debit_note", "DN");
      const ins = await client.query(
        `INSERT INTO public.debit_notes (note_number, original_invoice_id, amount, tax_amount, reason, issue_date, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [noteNumber, originalInvoiceId, amt, tax, reason || null, issueDate, req.user.id]
      );
      const note = ins.rows[0];
      const arAccount = await getAccountByCode(client, "1130");
      const revenueAccount = await getAccountByCode(client, "4100");
      const taxAccount = await getAccountByCode(client, "2200");
      const lines = [{ accountId: arAccount, debit: amt + tax, credit: 0 }, { accountId: revenueAccount, debit: 0, credit: amt }];
      if (tax > 0) lines.push({ accountId: taxAccount, debit: 0, credit: tax });
      await postJournalEntry(client, { date: issueDate, sourceType: "debit_note", sourceId: note.id, description: `إشعار مدين ${noteNumber}`, lines, userId: req.user.id });
      await auditLog(client, { userId: req.user.id, action: "debit_note.create", entityType: "debit_notes", entityId: note.id, after: note });
      await client.query("COMMIT");
      res.status(201).json(note);
    } catch (e) {
      await client.query("ROLLBACK");
      if (e instanceof PeriodClosedError) return res.status(409).json({ error: e.message });
      console.error("POST /accounting/debit-notes:", e);
      res.status(400).json({ error: e.message || "server_error" });
    } finally { client.release(); }
  });

  /* ===================== المقبوضات (Receipts) ===================== */
  app.get("/accounting/receipts", auth, requireManager, async (req, res) => {
    try {
      const q = await pool.query(`SELECT * FROM public.receipts ORDER BY created_at DESC LIMIT 500`);
      res.json(q.rows.map((r) => ({
        id: r.id, invoiceId: r.invoice_id, clientId: r.client_id, amount: Number(r.amount), method: r.method,
        accountId: r.account_id, paymentDate: r.payment_date, reference: r.reference, notes: r.notes,
      })));
    } catch (e) {
      console.error("GET /accounting/receipts:", e);
      res.status(500).json({ error: "server_error" });
    }
  });

  app.post("/accounting/receipts", auth, requireManager, async (req, res) => {
    const client = await pool.connect();
    try {
      const { invoiceId, clientId, amount, method, accountId, paymentDate, reference, notes } = req.body || {};
      const amt = Number(amount);
      if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: "bad_amount" });
      if (!accountId || !["cash", "bank_transfer", "card", "other"].includes(method)) return res.status(400).json({ error: "bad_input" });

      await client.query("BEGIN");
      let invoice = null;
      if (invoiceId) {
        const inv = await client.query(`SELECT * FROM public.invoices WHERE id=$1 FOR UPDATE`, [invoiceId]);
        if (!inv.rowCount) { await client.query("ROLLBACK"); return res.status(404).json({ error: "invoice_not_found" }); }
        invoice = inv.rows[0];
        if (!["approved", "sent", "partially_paid"].includes(invoice.status)) {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: "invoice_not_receivable" });
        }
        const remaining = Math.round((Number(invoice.total) - Number(invoice.amount_paid)) * 100) / 100;
        if (amt > remaining + 0.01) {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: "amount_exceeds_remaining", remaining });
        }
      }

      const ins = await client.query(
        `INSERT INTO public.receipts (invoice_id, client_id, amount, method, account_id, payment_date, reference, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [invoiceId || null, clientId || (invoice ? invoice.client_id : null), amt, method, accountId, paymentDate, reference || null, notes || null, req.user.id]
      );
      const receipt = ins.rows[0];

      const arAccount = await getAccountByCode(client, "1130");
      const creditAccountId = invoice ? arAccount : (req.body.creditAccountId || (await getAccountByCode(client, "4900")));

      await postJournalEntry(client, {
        date: paymentDate, sourceType: "receipt", sourceId: receipt.id,
        description: `مقبوضات${invoice ? " - فاتورة " + invoice.invoice_number : ""}`,
        lines: [{ accountId, debit: amt, credit: 0 }, { accountId: creditAccountId, debit: 0, credit: amt }],
        userId: req.user.id,
      });

      if (invoice) {
        const newPaid = Math.round((Number(invoice.amount_paid) + amt) * 100) / 100;
        const newStatus = newPaid >= Number(invoice.total) - 0.01 ? "paid" : "partially_paid";
        await client.query(`UPDATE public.invoices SET amount_paid=$1, status=$2, updated_at=now() WHERE id=$3`, [newPaid, newStatus, invoice.id]);
      }

      await auditLog(client, { userId: req.user.id, action: "receipt.create", entityType: "receipts", entityId: receipt.id, after: receipt });
      await client.query("COMMIT");
      res.status(201).json({ id: receipt.id, amount: amt });
    } catch (e) {
      await client.query("ROLLBACK");
      if (e instanceof PeriodClosedError) return res.status(409).json({ error: e.message });
      console.error("POST /accounting/receipts:", e);
      res.status(400).json({ error: e.message || "server_error" });
    } finally {
      client.release();
    }
  });

  /* ===================== الاشتراكات المتكررة ===================== */
  app.get("/accounting/subscriptions", auth, requireManager, async (req, res) => {
    try {
      const q = await pool.query(`SELECT * FROM public.subscriptions ORDER BY id DESC`);
      res.json(q.rows.map((r) => ({
        id: r.id, clientId: r.client_id, serviceId: r.service_id, amount: Number(r.amount), billingCycle: r.billing_cycle,
        startDate: r.start_date, endDate: r.end_date, nextInvoiceDate: r.next_invoice_date, status: r.status,
      })));
    } catch (e) {
      console.error("GET /accounting/subscriptions:", e);
      res.status(500).json({ error: "server_error" });
    }
  });

  app.post("/accounting/subscriptions", auth, requireManager, async (req, res) => {
    try {
      const { clientId, serviceId, amount, billingCycle, startDate, endDate } = req.body || {};
      if (!clientId || !Number.isFinite(Number(amount)) || !["monthly", "yearly"].includes(billingCycle) || !startDate) {
        return res.status(400).json({ error: "bad_input" });
      }
      const q = await pool.query(
        `INSERT INTO public.subscriptions (client_id, service_id, amount, billing_cycle, start_date, end_date, next_invoice_date)
         VALUES ($1,$2,$3,$4,$5,$6,$5) RETURNING *`,
        [clientId, serviceId || null, amount, billingCycle, startDate, endDate || null]
      );
      res.status(201).json(q.rows[0]);
    } catch (e) {
      console.error("POST /accounting/subscriptions:", e);
      res.status(500).json({ error: "server_error" });
    }
  });

  app.patch("/accounting/subscriptions/:id", auth, requireManager, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const { status } = req.body || {};
      if (!["active", "paused", "ended"].includes(status)) return res.status(400).json({ error: "bad_status" });
      const q = await pool.query(`UPDATE public.subscriptions SET status=$1 WHERE id=$2 RETURNING *`, [status, id]);
      if (!q.rowCount) return res.status(404).json({ error: "not_found" });
      res.json(q.rows[0]);
    } catch (e) {
      console.error("PATCH /accounting/subscriptions/:id:", e);
      res.status(500).json({ error: "server_error" });
    }
  });

  function addCycle(dateStr, cycle) {
    const d = new Date(dateStr);
    if (cycle === "monthly") d.setMonth(d.getMonth() + 1);
    else d.setFullYear(d.getFullYear() + 1);
    return d.toISOString().slice(0, 10);
  }

  async function generateSubscriptionInvoices() {
    try {
      await bootstrapDone;
      const today = new Date().toISOString().slice(0, 10);
      const due = await pool.query(
        `SELECT * FROM public.subscriptions WHERE status='active' AND next_invoice_date <= $1 AND (end_date IS NULL OR end_date >= $1)`,
        [today]
      );
      for (const sub of due.rows) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const locked = await client.query(`SELECT * FROM public.subscriptions WHERE id=$1 FOR UPDATE`, [sub.id]);
          const s = locked.rows[0];
          if (s.next_invoice_date > today || s.status !== "active") { await client.query("ROLLBACK"); continue; }
          const svc = s.service_id ? await client.query(`SELECT name FROM public.services WHERE id=$1`, [s.service_id]) : null;
          await createDraftInvoice(client, {
            clientId: s.client_id, issueDate: today,
            dueDate: addCycle(today, "monthly"),
            items: [{ serviceId: s.service_id, description: (svc && svc.rows[0] && svc.rows[0].name) || "اشتراك", quantity: 1, unitPrice: Number(s.amount) }],
            userId: null,
          });
          await client.query(`UPDATE public.subscriptions SET next_invoice_date=$1 WHERE id=$2`, [addCycle(s.next_invoice_date.toISOString().slice(0, 10), s.billing_cycle), s.id]);
          await client.query("COMMIT");
          console.log("🔁 subscription invoice generated for subscription", s.id);
        } catch (e) {
          await client.query("ROLLBACK");
          console.error("generateSubscriptionInvoices error for sub", sub.id, e.message);
        } finally {
          client.release();
        }
      }
    } catch (e) {
      console.error("generateSubscriptionInvoices error:", e.message);
    }
  }
  generateSubscriptionInvoices();
  setInterval(generateSubscriptionInvoices, 6 * 60 * 60 * 1000);

  /* ===================== أعمار الذمم المدينة ===================== */
  app.get("/accounting/reports/ar-aging", auth, requireManager, async (req, res) => {
    try {
      const q = await pool.query(`
        SELECT i.id, i.invoice_number AS "invoiceNumber", c.name AS "clientName",
               (i.total - i.amount_paid) AS "remaining", i.due_date AS "dueDate",
               (CURRENT_DATE - i.due_date) AS "daysOverdue"
          FROM public.invoices i JOIN public.clients c ON c.id = i.client_id
         WHERE i.status IN ('approved','sent','partially_paid','overdue') AND (i.total - i.amount_paid) > 0.01
         ORDER BY i.due_date`);
      const bucket = (d) => (d <= 0 ? "current" : d <= 30 ? "d1_30" : d <= 60 ? "d31_60" : d <= 90 ? "d61_90" : "d90_plus");
      const rows = q.rows.map((r) => ({ ...r, remaining: Number(r.remaining), bucket: bucket(Number(r.daysOverdue)) }));
      res.json(rows);
    } catch (e) {
      console.error("GET /accounting/reports/ar-aging:", e);
      res.status(500).json({ error: "server_error" });
    }
  });

  console.log("✅ accounting-ar routes mounted (invoices / credit-debit-notes-tables / subscriptions / receipts / ar-aging)");
}
