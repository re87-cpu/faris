// FILE: C:\faris-api\accounting-assets.mjs
// جزء المحاسبة: الأصول الثابتة — تسجيل، إهلاك شهري تلقائي (قسط ثابت)، استبعاد/بيع.

export default function mountAssets(app, pool, ctx) {
  const { auth, requireManager, postJournalEntry, auditLog, getAccountByCode, PeriodClosedError } = ctx;

  const bootstrapDone = (async () => {
    await ctx.bootstrapDone;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS public.fixed_assets (
          id                              serial PRIMARY KEY,
          name                            text NOT NULL,
          category                        text,
          cost                            numeric(14,2) NOT NULL CHECK (cost > 0),
          purchase_date                   date NOT NULL,
          useful_life_years               numeric(6,2) NOT NULL CHECK (useful_life_years > 0),
          depreciation_method             text NOT NULL DEFAULT 'straight_line' CHECK (depreciation_method IN ('straight_line')),
          salvage_value                   numeric(14,2) NOT NULL DEFAULT 0,
          status                          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disposed')),
          created_at                      timestamptz NOT NULL DEFAULT now()
        )`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS public.fixed_asset_depreciation_entries (
          id            serial PRIMARY KEY,
          asset_id      integer NOT NULL REFERENCES public.fixed_assets(id),
          period_year   integer NOT NULL,
          period_month  integer NOT NULL,
          amount        numeric(14,2) NOT NULL,
          created_at    timestamptz NOT NULL DEFAULT now(),
          UNIQUE (asset_id, period_year, period_month)
        )`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS public.fixed_asset_disposals (
          id             serial PRIMARY KEY,
          asset_id       integer NOT NULL UNIQUE REFERENCES public.fixed_assets(id),
          disposal_date  date NOT NULL,
          proceeds       numeric(14,2) NOT NULL DEFAULT 0,
          gain_loss      numeric(14,2) NOT NULL DEFAULT 0,
          created_at     timestamptz NOT NULL DEFAULT now()
        )`);
      await client.query("COMMIT");
      console.log("✅ accounting-assets: جداول الأصول الثابتة والإهلاك جاهزة");
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("accounting-assets bootstrap error:", e.message);
    } finally { client.release(); }
  })();

  async function accumulatedDepreciation(assetId) {
    const q = await pool.query(`SELECT COALESCE(SUM(amount),0) s FROM public.fixed_asset_depreciation_entries WHERE asset_id=$1`, [assetId]);
    return Number(q.rows[0].s);
  }

  /* ===================== الأصول ===================== */
  app.get("/accounting/fixed-assets", auth, requireManager, async (req, res) => {
    try {
      const q = await pool.query(`SELECT * FROM public.fixed_assets ORDER BY purchase_date DESC`);
      const rows = [];
      for (const r of q.rows) {
        const acc = await accumulatedDepreciation(r.id);
        rows.push({
          id: r.id, name: r.name, category: r.category, cost: Number(r.cost), purchaseDate: r.purchase_date,
          usefulLifeYears: Number(r.useful_life_years), salvageValue: Number(r.salvage_value), status: r.status,
          accumulatedDepreciation: acc, bookValue: Math.round((Number(r.cost) - acc) * 100) / 100,
        });
      }
      res.json(rows);
    } catch (e) { console.error("GET /accounting/fixed-assets:", e); res.status(500).json({ error: "server_error" }); }
  });

  app.post("/accounting/fixed-assets", auth, requireManager, async (req, res) => {
    const client = await pool.connect();
    try {
      const { name, category, cost, purchaseDate, usefulLifeYears, salvageValue, paidFromAccountId } = req.body || {};
      const c = Number(cost), life = Number(usefulLifeYears);
      if (!name || !Number.isFinite(c) || c <= 0 || !purchaseDate || !Number.isFinite(life) || life <= 0 || !paidFromAccountId) {
        return res.status(400).json({ error: "bad_input" });
      }
      await client.query("BEGIN");
      const ins = await client.query(
        `INSERT INTO public.fixed_assets (name, category, cost, purchase_date, useful_life_years, salvage_value)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [name, category || null, c, purchaseDate, life, salvageValue || 0]
      );
      const asset = ins.rows[0];
      const fixedAssetAccount = await getAccountByCode(client, "1200");
      await postJournalEntry(client, {
        date: purchaseDate, sourceType: "manual", sourceId: null, description: `شراء أصل ثابت: ${name}`, isManual: true,
        lines: [{ accountId: fixedAssetAccount, debit: c, credit: 0 }, { accountId: paidFromAccountId, debit: 0, credit: c }],
        userId: req.user.id,
      });
      await auditLog(client, { userId: req.user.id, action: "fixed_asset.create", entityType: "fixed_assets", entityId: asset.id, after: asset });
      await client.query("COMMIT");
      res.status(201).json({ id: asset.id });
    } catch (e) {
      await client.query("ROLLBACK");
      if (e instanceof PeriodClosedError) return res.status(409).json({ error: e.message });
      console.error("POST /accounting/fixed-assets:", e);
      res.status(400).json({ error: e.message || "server_error" });
    } finally { client.release(); }
  });

  /* ===================== الإهلاك الدوري (تلقائي + قابل للتشغيل يدويًا) ===================== */
  async function runDepreciationForPeriod(year, month) {
    const assets = await pool.query(`SELECT * FROM public.fixed_assets WHERE status='active'`);
    const periodEnd = new Date(year, month, 0); // آخر يوم بالشهر
    for (const asset of assets.rows) {
      const purchase = new Date(asset.purchase_date);
      if (purchase > periodEnd) continue; // لم يُشترَ بعد بهذه الفترة
      const monthlyAmount = Math.round(((Number(asset.cost) - Number(asset.salvage_value)) / (Number(asset.useful_life_years) * 12)) * 100) / 100;
      if (monthlyAmount <= 0) continue;

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const claim = await client.query(
          `INSERT INTO public.fixed_asset_depreciation_entries (asset_id, period_year, period_month, amount)
           VALUES ($1,$2,$3,$4) ON CONFLICT (asset_id, period_year, period_month) DO NOTHING RETURNING id`,
          [asset.id, year, month, monthlyAmount]
        );
        if (!claim.rowCount) { await client.query("ROLLBACK"); continue; } // مُرحَّل مسبقًا لهذه الفترة

        const depExpense = await getAccountByCode(client, "5700");
        const accumDep = await getAccountByCode(client, "1210");
        const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(periodEnd.getDate()).padStart(2, "0")}`;
        await postJournalEntry(client, {
          date: dateStr, sourceType: "fixed_asset_depreciation", sourceId: claim.rows[0].id,
          description: `إهلاك ${asset.name} - ${month}/${year}`,
          lines: [{ accountId: depExpense, debit: monthlyAmount, credit: 0 }, { accountId: accumDep, debit: 0, credit: monthlyAmount }],
        });
        await client.query("COMMIT");
        console.log("📉 depreciation posted for asset", asset.id, `${month}/${year}`, monthlyAmount);
      } catch (e) {
        await client.query("ROLLBACK");
        console.error("runDepreciationForPeriod error for asset", asset.id, e.message);
      } finally { client.release(); }
    }
  }

  async function monthlyDepreciationTick() {
    try {
      await bootstrapDone;
      const now = new Date();
      await runDepreciationForPeriod(now.getFullYear(), now.getMonth() + 1);
    } catch (e) { console.error("monthlyDepreciationTick error:", e.message); }
  }
  monthlyDepreciationTick();
  setInterval(monthlyDepreciationTick, 6 * 60 * 60 * 1000);

  // تشغيل يدوي لفترة محدّدة (مفيد للاختبار أو تعويض شهر فائت) — نفس منطق عدم الازدواج.
  app.post("/accounting/fixed-assets/run-depreciation", auth, requireManager, async (req, res) => {
    try {
      const { year, month } = req.body || {};
      const y = Number(year), m = Number(month);
      if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) return res.status(400).json({ error: "bad_input" });
      await runDepreciationForPeriod(y, m);
      res.json({ ok: true });
    } catch (e) { console.error("POST /accounting/fixed-assets/run-depreciation:", e); res.status(500).json({ error: "server_error" }); }
  });

  /* ===================== استبعاد/بيع أصل ===================== */
  app.post("/accounting/fixed-assets/:id/dispose", auth, requireManager, async (req, res) => {
    const client = await pool.connect();
    try {
      const id = Number(req.params.id);
      const { disposalDate, proceeds, receiveIntoAccountId } = req.body || {};
      const proc = Number(proceeds || 0);
      if (!disposalDate || !receiveIntoAccountId) return res.status(400).json({ error: "bad_input" });

      await client.query("BEGIN");
      const cur = await client.query(`SELECT * FROM public.fixed_assets WHERE id=$1 FOR UPDATE`, [id]);
      if (!cur.rowCount) { await client.query("ROLLBACK"); return res.status(404).json({ error: "not_found" }); }
      const asset = cur.rows[0];
      if (asset.status === "disposed") { await client.query("ROLLBACK"); return res.status(409).json({ error: "already_disposed" }); }

      const accDep = await accumulatedDepreciation(id);
      const bookValue = Math.round((Number(asset.cost) - accDep) * 100) / 100;
      const gainLoss = Math.round((proc - bookValue) * 100) / 100;

      const fixedAssetAccount = await getAccountByCode(client, "1200");
      const accumDepAccount = await getAccountByCode(client, "1210");
      const otherRevenue = await getAccountByCode(client, "4900");
      const otherExpense = await getAccountByCode(client, "5900");

      const lines = [{ accountId: fixedAssetAccount, debit: 0, credit: Number(asset.cost) }];
      if (accDep > 0) lines.push({ accountId: accumDepAccount, debit: accDep, credit: 0 });
      if (proc > 0) lines.push({ accountId: receiveIntoAccountId, debit: proc, credit: 0 });
      if (gainLoss > 0) lines.push({ accountId: otherRevenue, debit: 0, credit: gainLoss });
      if (gainLoss < 0) lines.push({ accountId: otherExpense, debit: -gainLoss, credit: 0 });

      const disp = await client.query(
        `INSERT INTO public.fixed_asset_disposals (asset_id, disposal_date, proceeds, gain_loss) VALUES ($1,$2,$3,$4) RETURNING *`,
        [id, disposalDate, proc, gainLoss]
      );
      await postJournalEntry(client, { date: disposalDate, sourceType: "fixed_asset_disposal", sourceId: disp.rows[0].id, description: `استبعاد/بيع أصل: ${asset.name}`, lines, userId: req.user.id });
      await client.query(`UPDATE public.fixed_assets SET status='disposed' WHERE id=$1`, [id]);
      await auditLog(client, { userId: req.user.id, action: "fixed_asset.dispose", entityType: "fixed_assets", entityId: id, after: disp.rows[0] });
      await client.query("COMMIT");
      res.json({ id, bookValue, gainLoss });
    } catch (e) {
      await client.query("ROLLBACK");
      if (e instanceof PeriodClosedError) return res.status(409).json({ error: e.message });
      console.error("POST /accounting/fixed-assets/:id/dispose:", e);
      res.status(400).json({ error: e.message || "server_error" });
    } finally { client.release(); }
  });

  console.log("✅ accounting-assets routes mounted (fixed-assets / depreciation / disposal)");
}
