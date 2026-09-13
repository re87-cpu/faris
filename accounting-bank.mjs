// FILE: C:\faris-api\accounting-bank.mjs
// جزء المحاسبة: الصندوق والبنوك — لا جدول منفصل للأرصدة (تُشتق من journal_lines
// لحساب الصندوق/البنك في دليل الحسابات)، فقط بيانات وصفية للحسابات البنكية،
// تحويلات بين الحسابات، والتسويات البنكية.

export default function mountBank(app, pool, ctx) {
  const { auth, requireManager, postJournalEntry, auditLog, PeriodClosedError } = ctx;

  const bootstrapDone = (async () => {
    await ctx.bootstrapDone;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS public.bank_accounts (
          id             serial PRIMARY KEY,
          account_id     integer NOT NULL UNIQUE REFERENCES public.accounting_accounts(id),
          bank_name      text NOT NULL,
          iban           text,
          account_number text,
          created_at     timestamptz NOT NULL DEFAULT now()
        )`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS public.bank_statement_lines (
          id                    serial PRIMARY KEY,
          bank_account_id       integer NOT NULL REFERENCES public.bank_accounts(id),
          stmt_date             date NOT NULL,
          description           text,
          amount                numeric(14,2) NOT NULL,
          matched_journal_line_id integer REFERENCES public.journal_lines(id),
          status                text NOT NULL DEFAULT 'unmatched' CHECK (status IN ('unmatched','matched','adjusted')),
          created_at            timestamptz NOT NULL DEFAULT now()
        )`);
      await client.query("COMMIT");
      console.log("✅ accounting-bank: جداول الحسابات البنكية والتسويات جاهزة");
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("accounting-bank bootstrap error:", e.message);
    } finally {
      client.release();
    }
  })();

  /* ===================== الحسابات البنكية ===================== */
  app.get("/accounting/bank-accounts", auth, requireManager, async (req, res) => {
    try {
      const q = await pool.query(`
        SELECT ba.id, ba.account_id AS "accountId", aa.name AS "accountName", ba.bank_name AS "bankName",
               ba.iban, ba.account_number AS "accountNumber",
               COALESCE((SELECT SUM(debit)-SUM(credit) FROM public.journal_lines WHERE account_id = ba.account_id), 0) AS balance
          FROM public.bank_accounts ba JOIN public.accounting_accounts aa ON aa.id = ba.account_id
         ORDER BY ba.id`);
      res.json(q.rows.map((r) => ({ ...r, balance: Number(r.balance) })));
    } catch (e) { console.error("GET /accounting/bank-accounts:", e); res.status(500).json({ error: "server_error" }); }
  });

  app.post("/accounting/bank-accounts", auth, requireManager, async (req, res) => {
    const client = await pool.connect();
    try {
      const { bankName, iban, accountNumber, accountName } = req.body || {};
      if (!bankName || !accountName) return res.status(400).json({ error: "bad_input" });
      await client.query("BEGIN");
      const codeQ = await client.query(`SELECT code FROM public.accounting_accounts WHERE code LIKE '112%' ORDER BY code DESC LIMIT 1`);
      const lastCode = codeQ.rowCount ? Number(codeQ.rows[0].code) : 1120;
      const newCode = String(lastCode + 1);
      const acc = await client.query(
        `INSERT INTO public.accounting_accounts (code, name, type, subtype, parent_id)
         VALUES ($1,$2,'asset','bank',(SELECT id FROM public.accounting_accounts WHERE code='1100')) RETURNING id`,
        [newCode, accountName]
      );
      const ins = await client.query(
        `INSERT INTO public.bank_accounts (account_id, bank_name, iban, account_number) VALUES ($1,$2,$3,$4) RETURNING *`,
        [acc.rows[0].id, bankName, iban || null, accountNumber || null]
      );
      await auditLog(client, { userId: req.user.id, action: "bank_account.create", entityType: "bank_accounts", entityId: ins.rows[0].id, after: ins.rows[0] });
      await client.query("COMMIT");
      res.status(201).json({ id: ins.rows[0].id, accountId: acc.rows[0].id, bankName, iban, accountNumber, balance: 0 });
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("POST /accounting/bank-accounts:", e);
      res.status(500).json({ error: "server_error" });
    } finally { client.release(); }
  });

  /* ===================== تحويل بين حسابين (صندوق/بنك) ===================== */
  app.post("/accounting/transfers", auth, requireManager, async (req, res) => {
    const client = await pool.connect();
    try {
      const { fromAccountId, toAccountId, amount, date, notes } = req.body || {};
      const amt = Number(amount);
      if (!fromAccountId || !toAccountId || fromAccountId === toAccountId || !Number.isFinite(amt) || amt <= 0 || !date) {
        return res.status(400).json({ error: "bad_input" });
      }
      await client.query("BEGIN");
      const entryId = await postJournalEntry(client, {
        date, sourceType: "manual", sourceId: null, description: notes || "تحويل بين حسابات",
        lines: [{ accountId: toAccountId, debit: amt, credit: 0 }, { accountId: fromAccountId, debit: 0, credit: amt }],
        userId: req.user.id, isManual: true,
      });
      await auditLog(client, { userId: req.user.id, action: "transfer.create", entityType: "journal_entries", entityId: entryId, after: req.body });
      await client.query("COMMIT");
      res.status(201).json({ id: entryId });
    } catch (e) {
      await client.query("ROLLBACK");
      if (e instanceof PeriodClosedError) return res.status(409).json({ error: e.message });
      console.error("POST /accounting/transfers:", e);
      res.status(400).json({ error: e.message || "server_error" });
    } finally { client.release(); }
  });

  /* ===================== التسويات البنكية ===================== */
  app.get("/accounting/bank-statement-lines", auth, requireManager, async (req, res) => {
    try {
      const bankAccountId = Number(req.query.bankAccountId);
      const q = await pool.query(
        `SELECT * FROM public.bank_statement_lines WHERE bank_account_id = $1 ORDER BY stmt_date DESC`,
        [bankAccountId]
      );
      res.json(q.rows.map((r) => ({ id: r.id, bankAccountId: r.bank_account_id, date: r.stmt_date, description: r.description, amount: Number(r.amount), matchedJournalLineId: r.matched_journal_line_id, status: r.status })));
    } catch (e) { console.error("GET /accounting/bank-statement-lines:", e); res.status(500).json({ error: "server_error" }); }
  });

  app.post("/accounting/bank-statement-lines", auth, requireManager, async (req, res) => {
    try {
      const { bankAccountId, stmtDate, description, amount } = req.body || {};
      if (!bankAccountId || !stmtDate || !Number.isFinite(Number(amount))) return res.status(400).json({ error: "bad_input" });
      const q = await pool.query(
        `INSERT INTO public.bank_statement_lines (bank_account_id, stmt_date, description, amount) VALUES ($1,$2,$3,$4) RETURNING *`,
        [bankAccountId, stmtDate, description || null, amount]
      );
      res.status(201).json(q.rows[0]);
    } catch (e) { console.error("POST /accounting/bank-statement-lines:", e); res.status(500).json({ error: "server_error" }); }
  });

  // مطابقة سطر كشف بنكي بسطر قيد فعلي — أو تعليمه "معدَّل" إن لم يوجد تطابق
  app.post("/accounting/bank-statement-lines/:id/match", auth, requireManager, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const { journalLineId, status } = req.body || {};
      const q = await pool.query(
        `UPDATE public.bank_statement_lines SET matched_journal_line_id=$1, status=$2 WHERE id=$3 RETURNING *`,
        [journalLineId || null, status || "matched", id]
      );
      if (!q.rowCount) return res.status(404).json({ error: "not_found" });
      res.json(q.rows[0]);
    } catch (e) { console.error("POST /accounting/bank-statement-lines/:id/match:", e); res.status(500).json({ error: "server_error" }); }
  });

  console.log("✅ accounting-bank routes mounted (bank-accounts / transfers / bank-statement-lines)");
}
