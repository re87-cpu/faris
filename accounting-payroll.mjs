// FILE: C:\faris-api\accounting-payroll.mjs
// جزء المحاسبة: الرواتب — ملف راتب لكل موظف، سلف، مسير رواتب (مسودة→اعتماد→دفع)،
// وقيد محاسبي تلقائي عند الدفع فقط (لا قيد عند مجرد الاعتماد).

export default function mountPayroll(app, pool, ctx) {
  const { auth, requireManager, postJournalEntry, auditLog, getAccountByCode, PeriodClosedError } = ctx;

  const bootstrapDone = (async () => {
    await ctx.bootstrapDone;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS public.employee_salary_profiles (
          id                  serial PRIMARY KEY,
          user_id             integer NOT NULL UNIQUE REFERENCES public.users(id),
          base_salary         numeric(14,2) NOT NULL CHECK (base_salary >= 0),
          allowances           numeric(14,2) NOT NULL DEFAULT 0,
          default_deductions  numeric(14,2) NOT NULL DEFAULT 0,
          active              boolean NOT NULL DEFAULT true,
          created_at          timestamptz NOT NULL DEFAULT now()
        )`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS public.employee_advances (
          id         serial PRIMARY KEY,
          user_id    integer NOT NULL REFERENCES public.users(id),
          amount     numeric(14,2) NOT NULL CHECK (amount > 0),
          date       date NOT NULL,
          status     text NOT NULL DEFAULT 'outstanding' CHECK (status IN ('outstanding','settled')),
          created_at timestamptz NOT NULL DEFAULT now()
        )`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS public.payroll_runs (
          id            serial PRIMARY KEY,
          period_year   integer NOT NULL,
          period_month  integer NOT NULL CHECK (period_month BETWEEN 1 AND 12),
          status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','paid')),
          approved_by   integer REFERENCES public.users(id),
          approved_at   timestamptz,
          paid_at       timestamptz,
          created_at    timestamptz NOT NULL DEFAULT now(),
          UNIQUE (period_year, period_month)
        )`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS public.payroll_run_items (
          id                serial PRIMARY KEY,
          payroll_run_id    integer NOT NULL REFERENCES public.payroll_runs(id) ON DELETE CASCADE,
          user_id           integer NOT NULL REFERENCES public.users(id),
          base_salary       numeric(14,2) NOT NULL,
          allowances        numeric(14,2) NOT NULL DEFAULT 0,
          deductions        numeric(14,2) NOT NULL DEFAULT 0,
          advance_deduction numeric(14,2) NOT NULL DEFAULT 0,
          net_salary        numeric(14,2) NOT NULL,
          created_at        timestamptz NOT NULL DEFAULT now()
        )`);
      await client.query("COMMIT");
      console.log("✅ accounting-payroll: جداول الرواتب والسلف والمسير جاهزة");
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("accounting-payroll bootstrap error:", e.message);
    } finally { client.release(); }
  })();

  /* ===================== ملفات الرواتب ===================== */
  app.get("/accounting/payroll/profiles", auth, requireManager, async (req, res) => {
    try {
      const q = await pool.query(`
        SELECT p.id, p.user_id AS "userId", u.full_name AS "userName", p.base_salary AS "baseSalary",
               p.allowances, p.default_deductions AS "defaultDeductions", p.active
          FROM public.employee_salary_profiles p JOIN public.users u ON u.id = p.user_id
         ORDER BY u.full_name`);
      res.json(q.rows.map((r) => ({ ...r, baseSalary: Number(r.baseSalary), allowances: Number(r.allowances), defaultDeductions: Number(r.defaultDeductions) })));
    } catch (e) { console.error("GET /accounting/payroll/profiles:", e); res.status(500).json({ error: "server_error" }); }
  });

  app.post("/accounting/payroll/profiles", auth, requireManager, async (req, res) => {
    try {
      const { userId, baseSalary, allowances, defaultDeductions } = req.body || {};
      if (!userId || !Number.isFinite(Number(baseSalary))) return res.status(400).json({ error: "bad_input" });
      const q = await pool.query(
        `INSERT INTO public.employee_salary_profiles (user_id, base_salary, allowances, default_deductions)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (user_id) DO UPDATE SET base_salary=$2, allowances=$3, default_deductions=$4
         RETURNING *`,
        [userId, baseSalary, allowances || 0, defaultDeductions || 0]
      );
      res.status(201).json(q.rows[0]);
    } catch (e) { console.error("POST /accounting/payroll/profiles:", e); res.status(500).json({ error: "server_error" }); }
  });

  /* ===================== السلف ===================== */
  app.get("/accounting/payroll/advances", auth, requireManager, async (req, res) => {
    try {
      const q = await pool.query(`
        SELECT a.id, a.user_id AS "userId", u.full_name AS "userName", a.amount, a.date, a.status
          FROM public.employee_advances a JOIN public.users u ON u.id = a.user_id
         ORDER BY a.date DESC`);
      res.json(q.rows.map((r) => ({ ...r, amount: Number(r.amount) })));
    } catch (e) { console.error("GET /accounting/payroll/advances:", e); res.status(500).json({ error: "server_error" }); }
  });

  app.post("/accounting/payroll/advances", auth, requireManager, async (req, res) => {
    const client = await pool.connect();
    try {
      const { userId, amount, date, accountId } = req.body || {};
      const amt = Number(amount);
      if (!userId || !Number.isFinite(amt) || amt <= 0 || !date || !accountId) return res.status(400).json({ error: "bad_input" });
      await client.query("BEGIN");
      const ins = await client.query(`INSERT INTO public.employee_advances (user_id, amount, date) VALUES ($1,$2,$3) RETURNING *`, [userId, amt, date]);
      const otherReceivable = await getAccountByCode(client, "1140");
      await postJournalEntry(client, {
        date, sourceType: "manual", sourceId: null, description: "سلفة موظف", isManual: true,
        lines: [{ accountId: otherReceivable, debit: amt, credit: 0 }, { accountId, debit: 0, credit: amt }],
        userId: req.user.id,
      });
      await auditLog(client, { userId: req.user.id, action: "advance.create", entityType: "employee_advances", entityId: ins.rows[0].id, after: ins.rows[0] });
      await client.query("COMMIT");
      res.status(201).json(ins.rows[0]);
    } catch (e) {
      await client.query("ROLLBACK");
      if (e instanceof PeriodClosedError) return res.status(409).json({ error: e.message });
      console.error("POST /accounting/payroll/advances:", e);
      res.status(400).json({ error: e.message || "server_error" });
    } finally { client.release(); }
  });

  /* ===================== مسير الرواتب ===================== */
  app.get("/accounting/payroll/runs", auth, requireManager, async (req, res) => {
    try {
      const q = await pool.query(`SELECT * FROM public.payroll_runs ORDER BY period_year DESC, period_month DESC`);
      res.json(q.rows.map((r) => ({ id: r.id, periodYear: r.period_year, periodMonth: r.period_month, status: r.status, approvedAt: r.approved_at, paidAt: r.paid_at })));
    } catch (e) { console.error("GET /accounting/payroll/runs:", e); res.status(500).json({ error: "server_error" }); }
  });

  app.get("/accounting/payroll/runs/:id", auth, requireManager, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const run = await pool.query(`SELECT * FROM public.payroll_runs WHERE id=$1`, [id]);
      if (!run.rowCount) return res.status(404).json({ error: "not_found" });
      const items = await pool.query(`
        SELECT i.*, u.full_name AS "userName" FROM public.payroll_run_items i JOIN public.users u ON u.id=i.user_id WHERE i.payroll_run_id=$1`, [id]);
      res.json({
        id: run.rows[0].id, periodYear: run.rows[0].period_year, periodMonth: run.rows[0].period_month, status: run.rows[0].status,
        items: items.rows.map((it) => ({
          userId: it.user_id, userName: it.userName, baseSalary: Number(it.base_salary), allowances: Number(it.allowances),
          deductions: Number(it.deductions), advanceDeduction: Number(it.advance_deduction), netSalary: Number(it.net_salary),
        })),
      });
    } catch (e) { console.error("GET /accounting/payroll/runs/:id:", e); res.status(500).json({ error: "server_error" }); }
  });

  // إنشاء مسير جديد لشهر معيّن — يحسب الصافي تلقائيًا من ملفات الرواتب النشطة + خصم السلف المستحقة.
  app.post("/accounting/payroll/runs", auth, requireManager, async (req, res) => {
    const client = await pool.connect();
    try {
      const { periodYear, periodMonth } = req.body || {};
      if (!Number.isInteger(Number(periodYear)) || !Number.isInteger(Number(periodMonth))) return res.status(400).json({ error: "bad_input" });

      await client.query("BEGIN");
      const run = await client.query(
        `INSERT INTO public.payroll_runs (period_year, period_month) VALUES ($1,$2) RETURNING *`,
        [periodYear, periodMonth]
      );
      const profiles = await client.query(`SELECT * FROM public.employee_salary_profiles WHERE active = true`);
      for (const p of profiles.rows) {
        const outstanding = await client.query(
          `SELECT id, amount FROM public.employee_advances WHERE user_id=$1 AND status='outstanding' ORDER BY date`,
          [p.user_id]
        );
        const gross = Number(p.base_salary) + Number(p.allowances) - Number(p.default_deductions);
        let advanceDeduction = 0;
        for (const adv of outstanding.rows) {
          if (advanceDeduction + Number(adv.amount) <= gross) advanceDeduction += Number(adv.amount);
        }
        const net = Math.round((gross - advanceDeduction) * 100) / 100;
        await client.query(
          `INSERT INTO public.payroll_run_items (payroll_run_id, user_id, base_salary, allowances, deductions, advance_deduction, net_salary)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [run.rows[0].id, p.user_id, p.base_salary, p.allowances, p.default_deductions, advanceDeduction, net]
        );
      }
      await auditLog(client, { userId: req.user.id, action: "payroll_run.create", entityType: "payroll_runs", entityId: run.rows[0].id, after: run.rows[0] });
      await client.query("COMMIT");
      res.status(201).json(run.rows[0]);
    } catch (e) {
      await client.query("ROLLBACK");
      if (e.code === "23505") return res.status(409).json({ error: "period_already_has_run" });
      console.error("POST /accounting/payroll/runs:", e);
      res.status(400).json({ error: e.message || "server_error" });
    } finally { client.release(); }
  });

  app.post("/accounting/payroll/runs/:id/approve", auth, requireManager, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const q = await pool.query(
        `UPDATE public.payroll_runs SET status='approved', approved_by=$1, approved_at=now() WHERE id=$2 AND status='draft' RETURNING *`,
        [req.user.id, id]
      );
      if (!q.rowCount) return res.status(409).json({ error: "must_be_draft" });
      res.json(q.rows[0]);
    } catch (e) { console.error("POST /accounting/payroll/runs/:id/approve:", e); res.status(500).json({ error: "server_error" }); }
  });

  app.post("/accounting/payroll/runs/:id/pay", auth, requireManager, async (req, res) => {
    const client = await pool.connect();
    try {
      const id = Number(req.params.id);
      const { accountId, paymentDate } = req.body || {};
      if (!accountId || !paymentDate) return res.status(400).json({ error: "bad_input" });

      await client.query("BEGIN");
      const run = await client.query(`SELECT * FROM public.payroll_runs WHERE id=$1 FOR UPDATE`, [id]);
      if (!run.rowCount) { await client.query("ROLLBACK"); return res.status(404).json({ error: "not_found" }); }
      if (run.rows[0].status !== "approved") { await client.query("ROLLBACK"); return res.status(409).json({ error: "must_be_approved" }); }

      const items = await client.query(`SELECT * FROM public.payroll_run_items WHERE payroll_run_id=$1`, [id]);
      const gross = items.rows.reduce((s, it) => s + Number(it.base_salary) + Number(it.allowances) - Number(it.deductions), 0);
      const netTotal = items.rows.reduce((s, it) => s + Number(it.net_salary), 0);
      const advanceTotal = items.rows.reduce((s, it) => s + Number(it.advance_deduction), 0);

      const salariesExpense = await getAccountByCode(client, "5100");
      const otherReceivable = await getAccountByCode(client, "1140");

      const lines = [{ accountId: salariesExpense, debit: Math.round(gross * 100) / 100, credit: 0 }, { accountId, debit: 0, credit: Math.round(netTotal * 100) / 100 }];
      if (advanceTotal > 0) lines.push({ accountId: otherReceivable, debit: 0, credit: Math.round(advanceTotal * 100) / 100 });

      await postJournalEntry(client, { date: paymentDate, sourceType: "payroll_run", sourceId: id, description: `دفع رواتب ${run.rows[0].period_month}/${run.rows[0].period_year}`, lines, userId: req.user.id });

      if (advanceTotal > 0) {
        for (const it of items.rows) {
          if (Number(it.advance_deduction) > 0) {
            await client.query(`UPDATE public.employee_advances SET status='settled' WHERE user_id=$1 AND status='outstanding'`, [it.user_id]);
          }
        }
      }
      const upd = await client.query(`UPDATE public.payroll_runs SET status='paid', paid_at=now() WHERE id=$1 RETURNING *`, [id]);
      await auditLog(client, { userId: req.user.id, action: "payroll_run.pay", entityType: "payroll_runs", entityId: id, after: upd.rows[0] });
      await client.query("COMMIT");
      res.json(upd.rows[0]);
    } catch (e) {
      await client.query("ROLLBACK");
      if (e instanceof PeriodClosedError) return res.status(409).json({ error: e.message });
      console.error("POST /accounting/payroll/runs/:id/pay:", e);
      res.status(400).json({ error: e.message || "server_error" });
    } finally { client.release(); }
  });

  console.log("✅ accounting-payroll routes mounted (profiles / advances / runs)");
}
