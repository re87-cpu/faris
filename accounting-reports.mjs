// FILE: C:\faris-api\accounting-reports.mjs
// جزء المحاسبة: كشوف حسابات العملاء/الموردين (الأستاذ المساعد)، القوائم المالية
// الأساسية (دخل / ميزانية / تدفقات نقدية)، ولوحة تحكم المحاسبة.
// كل هذه المسارات قراءة فقط — تُبنى فوق journal_lines/invoices/purchase_invoices الموجودة.

export default function mountReports(app, pool, ctx) {
  const { auth, requireManager } = ctx;

  function rangeToDates(range, fromQ, toQ) {
    const today = new Date();
    const iso = (d) => d.toISOString().slice(0, 10);
    if (range === "custom" && fromQ && toQ) return { from: fromQ, to: toQ };
    if (range === "today") return { from: iso(today), to: iso(today) };
    if (range === "week") {
      const d = new Date(today); const diff = (d.getDay() + 1) % 7; d.setDate(d.getDate() - diff);
      const e = new Date(d); e.setDate(e.getDate() + 6);
      return { from: iso(d), to: iso(e) };
    }
    if (range === "quarter") {
      const q = Math.floor(today.getMonth() / 3);
      return { from: iso(new Date(today.getFullYear(), q * 3, 1)), to: iso(new Date(today.getFullYear(), q * 3 + 3, 0)) };
    }
    if (range === "year") return { from: `${today.getFullYear()}-01-01`, to: `${today.getFullYear()}-12-31` };
    // month (افتراضي)
    return { from: iso(new Date(today.getFullYear(), today.getMonth(), 1)), to: iso(new Date(today.getFullYear(), today.getMonth() + 1, 0)) };
  }

  /* ===================== كشف حساب العميل ===================== */
  app.get("/accounting/clients/:id/statement", auth, requireManager, async (req, res) => {
    try {
      const clientId = Number(req.params.id);
      const invoices = await pool.query(
        `SELECT id, invoice_number AS ref, issue_date AS date, total AS amount, 'invoice' AS kind FROM public.invoices WHERE client_id=$1 AND status <> 'draft'`,
        [clientId]
      );
      const receipts = await pool.query(
        `SELECT id, CAST(id AS text) AS ref, payment_date AS date, amount, 'receipt' AS kind FROM public.receipts WHERE client_id=$1`,
        [clientId]
      );
      const creditNotes = await pool.query(
        `SELECT cn.id, cn.note_number AS ref, cn.issue_date AS date, (cn.amount+cn.tax_amount) AS amount, 'credit_note' AS kind
           FROM public.credit_notes cn JOIN public.invoices i ON i.id = cn.original_invoice_id WHERE i.client_id=$1`,
        [clientId]
      );
      const rows = [
        ...invoices.rows.map((r) => ({ ...r, debit: Number(r.amount), credit: 0 })),
        ...receipts.rows.map((r) => ({ ...r, debit: 0, credit: Number(r.amount) })),
        ...creditNotes.rows.map((r) => ({ ...r, debit: 0, credit: Number(r.amount) })),
      ].sort((a, b) => new Date(a.date) - new Date(b.date));
      let balance = 0;
      const out = rows.map((r) => { balance += r.debit - r.credit; return { ...r, balance }; });
      res.json(out);
    } catch (e) { console.error("GET /accounting/clients/:id/statement:", e); res.status(500).json({ error: "server_error" }); }
  });

  /* ===================== كشف حساب المورد ===================== */
  app.get("/accounting/vendors/:id/statement", auth, requireManager, async (req, res) => {
    try {
      const vendorId = Number(req.params.id);
      const purchases = await pool.query(
        `SELECT id, invoice_number AS ref, issue_date AS date, total AS amount, 'purchase_invoice' AS kind FROM public.purchase_invoices WHERE vendor_id=$1 AND status <> 'draft'`,
        [vendorId]
      );
      const payments = await pool.query(
        `SELECT id, CAST(id AS text) AS ref, payment_date AS date, amount, 'payment_out' AS kind FROM public.payments_out WHERE vendor_id=$1`,
        [vendorId]
      );
      const rows = [
        ...purchases.rows.map((r) => ({ ...r, debit: 0, credit: Number(r.amount) })),
        ...payments.rows.map((r) => ({ ...r, debit: Number(r.amount), credit: 0 })),
      ].sort((a, b) => new Date(a.date) - new Date(b.date));
      let balance = 0;
      const out = rows.map((r) => { balance += r.credit - r.debit; return { ...r, balance }; });
      res.json(out);
    } catch (e) { console.error("GET /accounting/vendors/:id/statement:", e); res.status(500).json({ error: "server_error" }); }
  });

  /* ===================== قائمة الدخل ===================== */
  app.get("/accounting/reports/income-statement", auth, requireManager, async (req, res) => {
    try {
      const { from, to } = rangeToDates(req.query.range, req.query.from, req.query.to);
      const q = await pool.query(`
        SELECT a.type, a.code, a.name, COALESCE(SUM(jl.debit),0) AS debit, COALESCE(SUM(jl.credit),0) AS credit
          FROM public.accounting_accounts a
          JOIN public.journal_lines jl ON jl.account_id = a.id
          JOIN public.journal_entries je ON je.id = jl.entry_id
         WHERE a.type IN ('revenue','expense') AND je.entry_date BETWEEN $1 AND $2
         GROUP BY a.type, a.code, a.name ORDER BY a.code`, [from, to]);
      const revenue = q.rows.filter((r) => r.type === "revenue").map((r) => ({ code: r.code, name: r.name, amount: Number(r.credit) - Number(r.debit) }));
      const expense = q.rows.filter((r) => r.type === "expense").map((r) => ({ code: r.code, name: r.name, amount: Number(r.debit) - Number(r.credit) }));
      const totalRevenue = revenue.reduce((s, r) => s + r.amount, 0);
      const totalExpense = expense.reduce((s, r) => s + r.amount, 0);
      res.json({ from, to, revenue, expense, totalRevenue, totalExpense, netProfit: Math.round((totalRevenue - totalExpense) * 100) / 100 });
    } catch (e) { console.error("GET /accounting/reports/income-statement:", e); res.status(500).json({ error: "server_error" }); }
  });

  /* ===================== الميزانية العمومية ===================== */
  app.get("/accounting/reports/balance-sheet", auth, requireManager, async (req, res) => {
    try {
      const asOf = req.query.asOf || new Date().toISOString().slice(0, 10);
      const q = await pool.query(`
        SELECT a.type, a.code, a.name, COALESCE(SUM(jl.debit),0) AS debit, COALESCE(SUM(jl.credit),0) AS credit
          FROM public.accounting_accounts a
          LEFT JOIN public.journal_lines jl ON jl.account_id = a.id
          LEFT JOIN public.journal_entries je ON je.id = jl.entry_id AND je.entry_date <= $1
         WHERE a.type IN ('asset','liability','equity')
         GROUP BY a.type, a.code, a.name ORDER BY a.code`, [asOf]);
      const shape = (type, sign) => q.rows.filter((r) => r.type === type).map((r) => ({ code: r.code, name: r.name, balance: sign === "debit" ? Number(r.debit) - Number(r.credit) : Number(r.credit) - Number(r.debit) })).filter((r) => Math.round(r.balance * 100) !== 0);
      const assets = shape("asset", "debit");
      const liabilities = shape("liability", "credit");
      const equity = shape("equity", "credit");
      const totalAssets = Math.round(assets.reduce((s, r) => s + r.balance, 0) * 100) / 100;
      const totalLiabilities = Math.round(liabilities.reduce((s, r) => s + r.balance, 0) * 100) / 100;
      const totalEquity = Math.round(equity.reduce((s, r) => s + r.balance, 0) * 100) / 100;
      res.json({ asOf, assets, liabilities, equity, totalAssets, totalLiabilities, totalEquity, balanced: Math.round((totalAssets - totalLiabilities - totalEquity) * 100) === 0 });
    } catch (e) { console.error("GET /accounting/reports/balance-sheet:", e); res.status(500).json({ error: "server_error" }); }
  });

  /* ===================== قائمة التدفقات النقدية (مبسّطة، طريقة مباشرة) ===================== */
  app.get("/accounting/reports/cash-flow", auth, requireManager, async (req, res) => {
    try {
      const { from, to } = rangeToDates(req.query.range, req.query.from, req.query.to);
      const q = await pool.query(`
        SELECT a.id, a.name, je.source_type AS "sourceType", COALESCE(SUM(jl.debit),0) - COALESCE(SUM(jl.credit),0) AS net
          FROM public.accounting_accounts a
          JOIN public.journal_lines jl ON jl.account_id = a.id
          JOIN public.journal_entries je ON je.id = jl.entry_id
         WHERE a.subtype IN ('cash','bank') AND je.entry_date BETWEEN $1 AND $2
         GROUP BY a.id, a.name, je.source_type`, [from, to]);
      const byType = {};
      for (const r of q.rows) byType[r.sourceType] = (byType[r.sourceType] || 0) + Number(r.net);
      const operating = ["invoice", "receipt", "expense", "payment_out", "purchase_invoice", "payroll_run"].reduce((s, k) => s + (byType[k] || 0), 0);
      const investing = ["fixed_asset_disposal", "manual"].reduce((s, k) => s + (byType[k] || 0), 0);
      const netChange = Object.values(byType).reduce((s, v) => s + v, 0);
      res.json({
        from, to, byType,
        operatingActivities: Math.round(operating * 100) / 100,
        investingActivities: Math.round(investing * 100) / 100,
        netChange: Math.round(netChange * 100) / 100,
      });
    } catch (e) { console.error("GET /accounting/reports/cash-flow:", e); res.status(500).json({ error: "server_error" }); }
  });

  /* ===================== لوحة تحكم المحاسبة ===================== */
  app.get("/accounting/dashboard", auth, requireManager, async (req, res) => {
    try {
      const { from, to } = rangeToDates(req.query.range, req.query.from, req.query.to);

      const rev = await pool.query(`
        SELECT COALESCE(SUM(jl.credit)-SUM(jl.debit),0) s FROM public.journal_lines jl
          JOIN public.journal_entries je ON je.id=jl.entry_id JOIN public.accounting_accounts a ON a.id=jl.account_id
         WHERE a.type='revenue' AND je.entry_date BETWEEN $1 AND $2`, [from, to]);
      const exp = await pool.query(`
        SELECT COALESCE(SUM(jl.debit)-SUM(jl.credit),0) s FROM public.journal_lines jl
          JOIN public.journal_entries je ON je.id=jl.entry_id JOIN public.accounting_accounts a ON a.id=jl.account_id
         WHERE a.type='expense' AND je.entry_date BETWEEN $1 AND $2`, [from, to]);
      const ar = await pool.query(`SELECT COALESCE(SUM(total-amount_paid),0) s FROM public.invoices WHERE status IN ('approved','sent','partially_paid','overdue')`);
      const ap = await pool.query(`SELECT COALESCE(SUM(total-amount_paid),0) s FROM public.purchase_invoices WHERE status IN ('approved','partially_paid')`);
      const cashBank = await pool.query(`
        SELECT COALESCE(SUM(jl.debit)-SUM(jl.credit),0) s FROM public.journal_lines jl JOIN public.accounting_accounts a ON a.id=jl.account_id
         WHERE a.subtype IN ('cash','bank')`);
      const taxDue = await pool.query(`SELECT COALESCE(SUM(jl.credit)-SUM(jl.debit),0) s FROM public.journal_lines jl JOIN public.accounting_accounts a ON a.id=jl.account_id WHERE a.subtype='tax_payable'`);
      const overdueCount = await pool.query(`SELECT COUNT(*) c FROM public.invoices WHERE status IN ('approved','sent','partially_paid') AND due_date < CURRENT_DATE`);
      const dueSoonCount = await pool.query(`SELECT COUNT(*) c FROM public.invoices WHERE status IN ('approved','sent','partially_paid') AND due_date >= CURRENT_DATE AND due_date <= CURRENT_DATE + 7`);

      const totalRevenue = Number(rev.rows[0].s);
      const totalExpense = Number(exp.rows[0].s);
      res.json({
        from, to,
        totalRevenue, totalExpense, netProfit: Math.round((totalRevenue - totalExpense) * 100) / 100,
        totalReceivable: Number(ar.rows[0].s), totalPayable: Number(ap.rows[0].s),
        cashAndBankBalance: Number(cashBank.rows[0].s), taxDue: Number(taxDue.rows[0].s),
        overdueInvoices: Number(overdueCount.rows[0].c), dueSoonInvoices: Number(dueSoonCount.rows[0].c),
      });
    } catch (e) { console.error("GET /accounting/dashboard:", e); res.status(500).json({ error: "server_error" }); }
  });

  console.log("✅ accounting-reports routes mounted (client/vendor statements / income-statement / balance-sheet / cash-flow / dashboard)");
}
