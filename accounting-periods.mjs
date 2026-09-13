// FILE: C:\faris-api\accounting-periods.mjs
// جزء المحاسبة: الفترات المالية (فتح/إغلاق) والإقفال السنوي.

export default function mountPeriods(app, pool, ctx) {
  const { auth, requireManager, postJournalEntry, auditLog, getAccountByCode, PeriodClosedError } = ctx;

  app.get("/accounting/fiscal-years", auth, requireManager, async (req, res) => {
    try {
      const q = await pool.query(`SELECT * FROM public.fiscal_years ORDER BY year DESC`);
      res.json(q.rows);
    } catch (e) { console.error("GET /accounting/fiscal-years:", e); res.status(500).json({ error: "server_error" }); }
  });

  app.get("/accounting/fiscal-periods", auth, requireManager, async (req, res) => {
    try {
      const yearId = req.query.fiscalYearId ? Number(req.query.fiscalYearId) : null;
      const q = await pool.query(
        yearId
          ? `SELECT * FROM public.fiscal_periods WHERE fiscal_year_id=$1 ORDER BY period_start`
          : `SELECT * FROM public.fiscal_periods ORDER BY period_start DESC LIMIT 24`,
        yearId ? [yearId] : []
      );
      res.json(q.rows.map((r) => ({ id: r.id, fiscalYearId: r.fiscal_year_id, periodStart: r.period_start, periodEnd: r.period_end, status: r.status })));
    } catch (e) { console.error("GET /accounting/fiscal-periods:", e); res.status(500).json({ error: "server_error" }); }
  });

  // إغلاق/فتح فترة — محمي بقفل استشاري حتى لا يتزامن مع ترحيل قيد لنفس الفترة
  // (assertPeriodOpen داخل postJournalEntry تتحقق من الحالة، لكن القفل يمنع
  // السباق بين قراءتها وتحديثها في نفس اللحظة).
  app.post("/accounting/fiscal-periods/:id/close", auth, requireManager, async (req, res) => {
    const client = await pool.connect();
    try {
      const id = Number(req.params.id);
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock($1)`, [id]);
      const q = await client.query(`UPDATE public.fiscal_periods SET status='closed' WHERE id=$1 AND status='open' RETURNING *`, [id]);
      if (!q.rowCount) { await client.query("ROLLBACK"); return res.status(409).json({ error: "not_open_or_not_found" }); }
      await auditLog(client, { userId: req.user.id, action: "fiscal_period.close", entityType: "fiscal_periods", entityId: id, after: q.rows[0] });
      await client.query("COMMIT");
      res.json(q.rows[0]);
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("POST /accounting/fiscal-periods/:id/close:", e);
      res.status(500).json({ error: "server_error" });
    } finally { client.release(); }
  });

  app.post("/accounting/fiscal-periods/:id/open", auth, requireManager, async (req, res) => {
    const client = await pool.connect();
    try {
      const id = Number(req.params.id);
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock($1)`, [id]);
      const q = await client.query(`UPDATE public.fiscal_periods SET status='open' WHERE id=$1 AND status='closed' RETURNING *`, [id]);
      if (!q.rowCount) { await client.query("ROLLBACK"); return res.status(409).json({ error: "not_closed_or_not_found" }); }
      await auditLog(client, { userId: req.user.id, action: "fiscal_period.open", entityType: "fiscal_periods", entityId: id, after: q.rows[0] });
      await client.query("COMMIT");
      res.json(q.rows[0]);
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("POST /accounting/fiscal-periods/:id/open:", e);
      res.status(500).json({ error: "server_error" });
    } finally { client.release(); }
  });

  // فتح سنة مالية جديدة (يزرع 12 فترة شهرية مفتوحة) — للسنة التالية بعد الإقفال.
  app.post("/accounting/fiscal-years", auth, requireManager, async (req, res) => {
    const client = await pool.connect();
    try {
      const year = Number(req.body?.year);
      if (!Number.isInteger(year)) return res.status(400).json({ error: "bad_input" });
      await client.query("BEGIN");
      const yr = await client.query(
        `INSERT INTO public.fiscal_years (year, start_date, end_date, status) VALUES ($1,$2,$3,'open') RETURNING *`,
        [year, `${year}-01-01`, `${year}-12-31`]
      );
      const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      for (let m = 1; m <= 12; m++) {
        const start = new Date(year, m - 1, 1), end = new Date(year, m, 0);
        await client.query(`INSERT INTO public.fiscal_periods (fiscal_year_id, period_start, period_end, status) VALUES ($1,$2,$3,'open')`, [yr.rows[0].id, iso(start), iso(end)]);
      }
      await client.query("COMMIT");
      res.status(201).json(yr.rows[0]);
    } catch (e) {
      await client.query("ROLLBACK");
      if (e.code === "23505") return res.status(409).json({ error: "year_already_exists" });
      console.error("POST /accounting/fiscal-years:", e);
      res.status(500).json({ error: "server_error" });
    } finally { client.release(); }
  });

  // الإقفال السنوي: تصفير الإيرادات والمصروفات في الأرباح المرحّلة + إقفال السنة وكل فتراتها.
  app.post("/accounting/fiscal-years/:id/close-year", auth, requireManager, async (req, res) => {
    const client = await pool.connect();
    try {
      const id = Number(req.params.id);
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock($1)`, [id]);
      const yr = await client.query(`SELECT * FROM public.fiscal_years WHERE id=$1 FOR UPDATE`, [id]);
      if (!yr.rowCount) { await client.query("ROLLBACK"); return res.status(404).json({ error: "not_found" }); }
      if (yr.rows[0].status === "closed") { await client.query("ROLLBACK"); return res.status(409).json({ error: "already_closed" }); }
      const { start_date, end_date } = yr.rows[0];

      const balances = await client.query(`
        SELECT a.id, a.type, COALESCE(SUM(jl.debit),0) d, COALESCE(SUM(jl.credit),0) c
          FROM public.accounting_accounts a
          JOIN public.journal_lines jl ON jl.account_id = a.id
          JOIN public.journal_entries je ON je.id = jl.entry_id
         WHERE a.type IN ('revenue','expense') AND je.entry_date BETWEEN $1 AND $2
         GROUP BY a.id, a.type HAVING COALESCE(SUM(jl.debit),0) <> COALESCE(SUM(jl.credit),0)`,
        [start_date, end_date]
      );

      const lines = [];
      let totalRevenue = 0, totalExpense = 0;
      for (const r of balances.rows) {
        const netCredit = Number(r.c) - Number(r.d); // للإيرادات موجب عادة
        if (r.type === "revenue") { lines.push({ accountId: r.id, debit: netCredit > 0 ? netCredit : 0, credit: netCredit < 0 ? -netCredit : 0 }); totalRevenue += netCredit; }
        else { const netDebit = Number(r.d) - Number(r.c); lines.push({ accountId: r.id, debit: netDebit < 0 ? -netDebit : 0, credit: netDebit > 0 ? netDebit : 0 }); totalExpense += netDebit; }
      }
      const netProfit = Math.round((totalRevenue - totalExpense) * 100) / 100;
      const retainedEarnings = await getAccountByCode(client, "3100");
      if (netProfit > 0) lines.push({ accountId: retainedEarnings, debit: 0, credit: netProfit });
      else if (netProfit < 0) lines.push({ accountId: retainedEarnings, debit: -netProfit, credit: 0 });

      if (lines.length) {
        await postJournalEntry(client, {
          date: end_date, sourceType: "manual", sourceId: null, isManual: true,
          description: `إقفال سنة مالية ${yr.rows[0].year}`, lines, userId: req.user.id,
        });
      }

      await client.query(`UPDATE public.fiscal_periods SET status='closed' WHERE fiscal_year_id=$1 AND status='open'`, [id]);
      const upd = await client.query(`UPDATE public.fiscal_years SET status='closed' WHERE id=$1 RETURNING *`, [id]);
      await auditLog(client, { userId: req.user.id, action: "fiscal_year.close", entityType: "fiscal_years", entityId: id, after: { netProfit } });
      await client.query("COMMIT");
      res.json({ ...upd.rows[0], netProfit });
    } catch (e) {
      await client.query("ROLLBACK");
      if (e instanceof PeriodClosedError) return res.status(409).json({ error: e.message });
      console.error("POST /accounting/fiscal-years/:id/close-year:", e);
      res.status(400).json({ error: e.message || "server_error" });
    } finally { client.release(); }
  });

  console.log("✅ accounting-periods routes mounted (fiscal-years / fiscal-periods / close-year)");
}
