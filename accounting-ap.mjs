// FILE: C:\faris-api\accounting-ap.mjs
// جزء المحاسبة: الموردون→المشتريات→المصروفات→المدفوعات→أعمار الذمم الدائنة.

export default function mountAP(app, pool, ctx) {
  const { auth, requireManager, postJournalEntry, nextDocNumber, auditLog, currentVatRate, getAccountByCode, PeriodClosedError } = ctx;

  const bootstrapDone = (async () => {
    await ctx.bootstrapDone;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS public.purchase_invoices (
          id             serial PRIMARY KEY,
          invoice_number text UNIQUE NOT NULL,
          vendor_id      integer NOT NULL REFERENCES public.vendors(id),
          status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','partially_paid','paid','cancelled')),
          issue_date     date NOT NULL,
          due_date       date NOT NULL,
          subtotal       numeric(14,2) NOT NULL DEFAULT 0,
          tax_amount     numeric(14,2) NOT NULL DEFAULT 0,
          total          numeric(14,2) NOT NULL DEFAULT 0,
          amount_paid    numeric(14,2) NOT NULL DEFAULT 0,
          notes          text,
          created_by     integer REFERENCES public.users(id) ON DELETE SET NULL,
          created_at     timestamptz NOT NULL DEFAULT now(),
          updated_at     timestamptz NOT NULL DEFAULT now()
        )`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS public.purchase_invoice_items (
          id                 serial PRIMARY KEY,
          purchase_invoice_id integer NOT NULL REFERENCES public.purchase_invoices(id) ON DELETE CASCADE,
          description        text NOT NULL,
          quantity           numeric(12,2) NOT NULL DEFAULT 1,
          unit_price         numeric(14,2) NOT NULL,
          tax_rate           numeric(5,2) NOT NULL DEFAULT 0,
          line_total         numeric(14,2) NOT NULL,
          line_tax           numeric(14,2) NOT NULL DEFAULT 0
        )`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS public.expenses (
          id                     serial PRIMARY KEY,
          category_account_id    integer NOT NULL REFERENCES public.accounting_accounts(id),
          amount                 numeric(14,2) NOT NULL CHECK (amount > 0),
          paid_from_account_id   integer NOT NULL REFERENCES public.accounting_accounts(id),
          expense_date           date NOT NULL,
          vendor_id              integer REFERENCES public.vendors(id),
          vendor_name_free       text,
          description            text,
          attachment_url         text,
          cost_center_id         integer REFERENCES public.cost_centers(id),
          created_by             integer REFERENCES public.users(id) ON DELETE SET NULL,
          created_at             timestamptz NOT NULL DEFAULT now()
        )`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS public.payments_out (
          id                   serial PRIMARY KEY,
          purchase_invoice_id  integer REFERENCES public.purchase_invoices(id),
          vendor_id            integer REFERENCES public.vendors(id),
          amount               numeric(14,2) NOT NULL CHECK (amount > 0),
          account_id           integer NOT NULL REFERENCES public.accounting_accounts(id),
          payment_date         date NOT NULL,
          reference            text,
          notes                text,
          created_by           integer REFERENCES public.users(id) ON DELETE SET NULL,
          created_at           timestamptz NOT NULL DEFAULT now()
        )`);
      await client.query("COMMIT");
      console.log("✅ accounting-ap: جداول المشتريات/المصروفات/المدفوعات جاهزة");
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("accounting-ap bootstrap error:", e.message);
    } finally {
      client.release();
    }
  })();

  function poOut(p, items) {
    return {
      id: p.id, invoiceNumber: p.invoice_number, vendorId: p.vendor_id, status: p.status,
      issueDate: p.issue_date, dueDate: p.due_date, subtotal: Number(p.subtotal), taxAmount: Number(p.tax_amount),
      total: Number(p.total), amountPaid: Number(p.amount_paid), notes: p.notes,
      items: (items || []).map((it) => ({ id: it.id, description: it.description, quantity: Number(it.quantity), unitPrice: Number(it.unit_price), taxRate: Number(it.tax_rate), lineTotal: Number(it.line_total), lineTax: Number(it.line_tax) })),
    };
  }

  async function computeTotals(items, defaultVat) {
    let subtotal = 0, taxAmount = 0;
    const computed = [];
    for (const it of items) {
      const qty = Number(it.quantity || 1);
      const price = Number(it.unitPrice);
      const rate = it.taxRate !== undefined && it.taxRate !== null ? Number(it.taxRate) : defaultVat;
      const lineTotal = Math.round(qty * price * 100) / 100;
      const lineTax = Math.round(lineTotal * rate) / 100;
      subtotal += lineTotal; taxAmount += lineTax;
      computed.push({ ...it, quantity: qty, unitPrice: price, taxRate: rate, lineTotal, lineTax });
    }
    subtotal = Math.round(subtotal * 100) / 100;
    taxAmount = Math.round(taxAmount * 100) / 100;
    return { computed, subtotal, taxAmount, total: Math.round((subtotal + taxAmount) * 100) / 100 };
  }

  /* ===================== فواتير المشتريات ===================== */
  app.get("/accounting/purchase-invoices", auth, requireManager, async (req, res) => {
    try {
      const q = await pool.query(`SELECT * FROM public.purchase_invoices ORDER BY created_at DESC LIMIT 500`);
      res.json(q.rows.map((r) => poOut(r)));
    } catch (e) { console.error("GET /accounting/purchase-invoices:", e); res.status(500).json({ error: "server_error" }); }
  });

  app.get("/accounting/purchase-invoices/:id", auth, requireManager, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const p = await pool.query(`SELECT * FROM public.purchase_invoices WHERE id=$1`, [id]);
      if (!p.rowCount) return res.status(404).json({ error: "not_found" });
      const items = await pool.query(`SELECT * FROM public.purchase_invoice_items WHERE purchase_invoice_id=$1`, [id]);
      res.json(poOut(p.rows[0], items.rows));
    } catch (e) { console.error("GET /accounting/purchase-invoices/:id:", e); res.status(500).json({ error: "server_error" }); }
  });

  app.post("/accounting/purchase-invoices", auth, requireManager, async (req, res) => {
    const client = await pool.connect();
    try {
      const { vendorId, issueDate, dueDate, items, notes } = req.body || {};
      if (!vendorId || !Array.isArray(items) || !items.length) return res.status(400).json({ error: "bad_input" });
      const vat = await currentVatRate();
      const { computed, subtotal, taxAmount, total } = await computeTotals(items, vat);
      await client.query("BEGIN");
      const invoiceNumber = await nextDocNumber(client, "purchase_invoice", "PINV");
      const ins = await client.query(
        `INSERT INTO public.purchase_invoices (invoice_number, vendor_id, status, issue_date, due_date, subtotal, tax_amount, total, notes, created_by)
         VALUES ($1,$2,'draft',$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [invoiceNumber, vendorId, issueDate, dueDate, subtotal, taxAmount, total, notes || null, req.user.id]
      );
      const po = ins.rows[0];
      for (const it of computed) {
        await client.query(
          `INSERT INTO public.purchase_invoice_items (purchase_invoice_id, description, quantity, unit_price, tax_rate, line_total, line_tax)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [po.id, it.description || "", it.quantity, it.unitPrice, it.taxRate, it.lineTotal, it.lineTax]
        );
      }
      await auditLog(client, { userId: req.user.id, action: "purchase_invoice.create_draft", entityType: "purchase_invoices", entityId: po.id, after: po });
      await client.query("COMMIT");
      res.status(201).json(poOut(po, computed));
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("POST /accounting/purchase-invoices:", e);
      res.status(400).json({ error: e.message || "server_error" });
    } finally { client.release(); }
  });

  app.post("/accounting/purchase-invoices/:id/approve", auth, requireManager, async (req, res) => {
    const client = await pool.connect();
    try {
      const id = Number(req.params.id);
      await client.query("BEGIN");
      const cur = await client.query(`SELECT * FROM public.purchase_invoices WHERE id=$1 FOR UPDATE`, [id]);
      if (!cur.rowCount) { await client.query("ROLLBACK"); return res.status(404).json({ error: "not_found" }); }
      const po = cur.rows[0];
      if (po.status !== "draft") { await client.query("ROLLBACK"); return res.status(409).json({ error: "already_approved" }); }

      const apAccount = await getAccountByCode(client, "2100");
      const inputTaxAccount = await getAccountByCode(client, "2300");
      const items = await client.query(`SELECT description FROM public.purchase_invoice_items WHERE purchase_invoice_id=$1 LIMIT 1`, [id]);
      const expenseAccount = req.body.categoryAccountId || (await getAccountByCode(client, "5900"));

      const lines = [{ accountId: apAccount, debit: 0, credit: Number(po.total) }];
      const netAmount = Math.round((Number(po.total) - Number(po.tax_amount)) * 100) / 100;
      if (netAmount > 0) lines.push({ accountId: expenseAccount, debit: netAmount, credit: 0 });
      if (Number(po.tax_amount) > 0) lines.push({ accountId: inputTaxAccount, debit: Number(po.tax_amount), credit: 0 });

      await postJournalEntry(client, { date: po.issue_date, sourceType: "purchase_invoice", sourceId: po.id, description: `اعتماد فاتورة مشتريات ${po.invoice_number}`, lines, userId: req.user.id });
      const upd = await client.query(`UPDATE public.purchase_invoices SET status='approved', updated_at=now() WHERE id=$1 RETURNING *`, [id]);
      await auditLog(client, { userId: req.user.id, action: "purchase_invoice.approve", entityType: "purchase_invoices", entityId: id, before: po, after: upd.rows[0] });
      await client.query("COMMIT");
      res.json(poOut(upd.rows[0]));
    } catch (e) {
      await client.query("ROLLBACK");
      if (e instanceof PeriodClosedError) return res.status(409).json({ error: e.message });
      console.error("POST /accounting/purchase-invoices/:id/approve:", e);
      res.status(400).json({ error: e.message || "server_error" });
    } finally { client.release(); }
  });

  /* ===================== المصروفات ===================== */
  app.get("/accounting/expenses", auth, requireManager, async (req, res) => {
    try {
      const q = await pool.query(`SELECT * FROM public.expenses ORDER BY created_at DESC LIMIT 500`);
      res.json(q.rows.map((r) => ({
        id: r.id, categoryAccountId: r.category_account_id, amount: Number(r.amount), paidFromAccountId: r.paid_from_account_id,
        expenseDate: r.expense_date, vendorId: r.vendor_id, vendorNameFree: r.vendor_name_free, description: r.description,
        attachmentUrl: r.attachment_url, costCenterId: r.cost_center_id,
      })));
    } catch (e) { console.error("GET /accounting/expenses:", e); res.status(500).json({ error: "server_error" }); }
  });

  app.post("/accounting/expenses", auth, requireManager, async (req, res) => {
    const client = await pool.connect();
    try {
      const { categoryAccountId, amount, paidFromAccountId, expenseDate, vendorId, vendorNameFree, description, attachmentUrl, costCenterId } = req.body || {};
      const amt = Number(amount);
      if (!categoryAccountId || !paidFromAccountId || !Number.isFinite(amt) || amt <= 0 || !expenseDate) return res.status(400).json({ error: "bad_input" });

      await client.query("BEGIN");
      const ins = await client.query(
        `INSERT INTO public.expenses (category_account_id, amount, paid_from_account_id, expense_date, vendor_id, vendor_name_free, description, attachment_url, cost_center_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [categoryAccountId, amt, paidFromAccountId, expenseDate, vendorId || null, vendorNameFree || null, description || null, attachmentUrl || null, costCenterId || null, req.user.id]
      );
      const expense = ins.rows[0];
      await postJournalEntry(client, {
        date: expenseDate, sourceType: "expense", sourceId: expense.id, description: description || "مصروف",
        lines: [{ accountId: categoryAccountId, debit: amt, credit: 0, costCenterId: costCenterId || null }, { accountId: paidFromAccountId, debit: 0, credit: amt }],
        userId: req.user.id,
      });
      await auditLog(client, { userId: req.user.id, action: "expense.create", entityType: "expenses", entityId: expense.id, after: expense });
      await client.query("COMMIT");
      res.status(201).json({ id: expense.id });
    } catch (e) {
      await client.query("ROLLBACK");
      if (e instanceof PeriodClosedError) return res.status(409).json({ error: e.message });
      console.error("POST /accounting/expenses:", e);
      res.status(400).json({ error: e.message || "server_error" });
    } finally { client.release(); }
  });

  /* ===================== المدفوعات (للموردين/المصروفات) ===================== */
  app.get("/accounting/payments-out", auth, requireManager, async (req, res) => {
    try {
      const q = await pool.query(`SELECT * FROM public.payments_out ORDER BY created_at DESC LIMIT 500`);
      res.json(q.rows.map((r) => ({ id: r.id, purchaseInvoiceId: r.purchase_invoice_id, vendorId: r.vendor_id, amount: Number(r.amount), accountId: r.account_id, paymentDate: r.payment_date, reference: r.reference, notes: r.notes })));
    } catch (e) { console.error("GET /accounting/payments-out:", e); res.status(500).json({ error: "server_error" }); }
  });

  app.post("/accounting/payments-out", auth, requireManager, async (req, res) => {
    const client = await pool.connect();
    try {
      const { purchaseInvoiceId, vendorId, amount, accountId, paymentDate, reference, notes } = req.body || {};
      const amt = Number(amount);
      if (!accountId || !Number.isFinite(amt) || amt <= 0 || !paymentDate) return res.status(400).json({ error: "bad_input" });

      await client.query("BEGIN");
      let po = null;
      if (purchaseInvoiceId) {
        const cur = await client.query(`SELECT * FROM public.purchase_invoices WHERE id=$1 FOR UPDATE`, [purchaseInvoiceId]);
        if (!cur.rowCount) { await client.query("ROLLBACK"); return res.status(404).json({ error: "purchase_invoice_not_found" }); }
        po = cur.rows[0];
        const remaining = Math.round((Number(po.total) - Number(po.amount_paid)) * 100) / 100;
        if (amt > remaining + 0.01) { await client.query("ROLLBACK"); return res.status(409).json({ error: "amount_exceeds_remaining", remaining }); }
      }
      const ins = await client.query(
        `INSERT INTO public.payments_out (purchase_invoice_id, vendor_id, amount, account_id, payment_date, reference, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [purchaseInvoiceId || null, vendorId || (po ? po.vendor_id : null), amt, accountId, paymentDate, reference || null, notes || null, req.user.id]
      );
      const payment = ins.rows[0];
      const apAccount = await getAccountByCode(client, "2100");
      const debitAccountId = po ? apAccount : (req.body.debitAccountId || (await getAccountByCode(client, "5900")));
      await postJournalEntry(client, {
        date: paymentDate, sourceType: "payment_out", sourceId: payment.id, description: `مدفوعات${po ? " - فاتورة مشتريات " + po.invoice_number : ""}`,
        lines: [{ accountId: debitAccountId, debit: amt, credit: 0 }, { accountId, debit: 0, credit: amt }],
        userId: req.user.id,
      });
      if (po) {
        const newPaid = Math.round((Number(po.amount_paid) + amt) * 100) / 100;
        const newStatus = newPaid >= Number(po.total) - 0.01 ? "paid" : "partially_paid";
        await client.query(`UPDATE public.purchase_invoices SET amount_paid=$1, status=$2, updated_at=now() WHERE id=$3`, [newPaid, newStatus, po.id]);
      }
      await auditLog(client, { userId: req.user.id, action: "payment_out.create", entityType: "payments_out", entityId: payment.id, after: payment });
      await client.query("COMMIT");
      res.status(201).json({ id: payment.id });
    } catch (e) {
      await client.query("ROLLBACK");
      if (e instanceof PeriodClosedError) return res.status(409).json({ error: e.message });
      console.error("POST /accounting/payments-out:", e);
      res.status(400).json({ error: e.message || "server_error" });
    } finally { client.release(); }
  });

  /* ===================== أعمار الذمم الدائنة ===================== */
  app.get("/accounting/reports/ap-aging", auth, requireManager, async (req, res) => {
    try {
      const q = await pool.query(`
        SELECT p.id, p.invoice_number AS "invoiceNumber", v.name AS "vendorName",
               (p.total - p.amount_paid) AS "remaining", p.due_date AS "dueDate",
               (CURRENT_DATE - p.due_date) AS "daysOverdue"
          FROM public.purchase_invoices p JOIN public.vendors v ON v.id = p.vendor_id
         WHERE p.status IN ('approved','partially_paid') AND (p.total - p.amount_paid) > 0.01
         ORDER BY p.due_date`);
      const bucket = (d) => (d <= 0 ? "current" : d <= 30 ? "d1_30" : d <= 60 ? "d31_60" : d <= 90 ? "d61_90" : "d90_plus");
      res.json(q.rows.map((r) => ({ ...r, remaining: Number(r.remaining), bucket: bucket(Number(r.daysOverdue)) })));
    } catch (e) { console.error("GET /accounting/reports/ap-aging:", e); res.status(500).json({ error: "server_error" }); }
  });

  console.log("✅ accounting-ap routes mounted (purchase-invoices / expenses / payments-out / ap-aging)");
}
