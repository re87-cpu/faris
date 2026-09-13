// FILE: C:\faris-api\accounting-routes.mjs
// نظام المحاسبة الكامل (المحاسبة) — مستقل تمامًا عن صفحة "المالية" (financial_transactions).
// يُركّب من index.js:  mountAccounting(app, pool, { auth, roleOf })
//
// المبدأ الأساسي: كل قيد محاسبي يُنشأ عبر postJournalEntry() فقط — لا مسار آخر
// يكتب في journal_entries/journal_lines مباشرة. هذا يضمن أن كل القيود تمر بنفس
// فحوصات التوازن (مدين = دائن) وفتح الفترة المالية في مكان واحد.
//
// الملف مقسّم لعدة وحدات فرعية لسهولة الصيانة (كلها جزء من نفس "نظام المحاسبة"،
// تُركَّب من هنا فقط): accounting-ar.mjs (عملاء/فواتير/مقبوضات/اشتراكات).

import mountAR from "./accounting-ar.mjs";
import mountAP from "./accounting-ap.mjs";
import mountBank from "./accounting-bank.mjs";
import mountPayroll from "./accounting-payroll.mjs";
import mountAssets from "./accounting-assets.mjs";
import mountReports from "./accounting-reports.mjs";
import mountPeriods from "./accounting-periods.mjs";

export default function mountAccounting(app, pool, deps) {
  const { auth, roleOf } = deps;
  const isManager = (u) => roleOf(u) === "manager";
  const requireManager = (req, res, next) => {
    if (!isManager(req.user)) return res.status(403).json({ error: "forbidden" });
    next();
  };

  /* ===================== إنشاء الجداول (آمن، إضافي فقط) ===================== */
  const bootstrapDone = (async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // ---- أ) الأساسات ----
      await client.query(`
        CREATE TABLE IF NOT EXISTS public.accounting_accounts (
          id            serial PRIMARY KEY,
          code          text UNIQUE NOT NULL,
          name          text NOT NULL,
          type          text NOT NULL CHECK (type IN ('asset','liability','equity','revenue','expense')),
          subtype       text,
          parent_id     integer REFERENCES public.accounting_accounts(id),
          is_system     boolean NOT NULL DEFAULT false,
          active        boolean NOT NULL DEFAULT true,
          created_at    timestamptz NOT NULL DEFAULT now()
        )`);

      await client.query(`
        CREATE TABLE IF NOT EXISTS public.clients (
          id                      serial PRIMARY KEY,
          name                    text NOT NULL,
          type                    text NOT NULL DEFAULT 'individual' CHECK (type IN ('individual','company','institution','other')),
          tax_number              text,
          commercial_registration text,
          email                   text,
          phone                   text,
          billing_address         text,
          notes                   text,
          created_at              timestamptz NOT NULL DEFAULT now(),
          updated_at              timestamptz NOT NULL DEFAULT now()
        )`);

      await client.query(`
        CREATE TABLE IF NOT EXISTS public.services (
          id            serial PRIMARY KEY,
          name          text UNIQUE NOT NULL,
          default_price numeric(14,2),
          active        boolean NOT NULL DEFAULT true,
          created_at    timestamptz NOT NULL DEFAULT now()
        )`);

      await client.query(`
        CREATE TABLE IF NOT EXISTS public.vendors (
          id                      serial PRIMARY KEY,
          name                    text NOT NULL,
          tax_number              text,
          commercial_registration text,
          email                   text,
          phone                   text,
          address                 text,
          notes                   text,
          created_at              timestamptz NOT NULL DEFAULT now(),
          updated_at              timestamptz NOT NULL DEFAULT now()
        )`);

      await client.query(`
        CREATE TABLE IF NOT EXISTS public.cost_centers (
          id         serial PRIMARY KEY,
          name       text NOT NULL,
          kind       text NOT NULL DEFAULT 'cost_center' CHECK (kind IN ('cost_center','branch','department','activity')),
          active     boolean NOT NULL DEFAULT true,
          created_at timestamptz NOT NULL DEFAULT now()
        )`);

      await client.query(`
        CREATE TABLE IF NOT EXISTS public.currencies (
          id        serial PRIMARY KEY,
          code      text UNIQUE NOT NULL,
          name      text NOT NULL,
          is_active boolean NOT NULL DEFAULT true
        )`);
      await client.query(`
        INSERT INTO public.currencies (code, name, is_active)
        VALUES ('SAR', 'ريال سعودي', true)
        ON CONFLICT (code) DO NOTHING`);

      await client.query(`
        CREATE TABLE IF NOT EXISTS public.accounting_tax_settings (
          id             serial PRIMARY KEY,
          vat_rate       numeric(5,2) NOT NULL CHECK (vat_rate >= 0),
          effective_from date NOT NULL,
          created_at     timestamptz NOT NULL DEFAULT now()
        )`);
      const taxRow = await client.query(`SELECT 1 FROM public.accounting_tax_settings LIMIT 1`);
      if (!taxRow.rowCount) {
        await client.query(
          `INSERT INTO public.accounting_tax_settings (vat_rate, effective_from) VALUES (15.00, CURRENT_DATE)`
        );
      }

      await client.query(`
        CREATE TABLE IF NOT EXISTS public.fiscal_years (
          id         serial PRIMARY KEY,
          year       integer UNIQUE NOT NULL,
          start_date date NOT NULL,
          end_date   date NOT NULL,
          status     text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed'))
        )`);

      await client.query(`
        CREATE TABLE IF NOT EXISTS public.fiscal_periods (
          id             serial PRIMARY KEY,
          fiscal_year_id integer NOT NULL REFERENCES public.fiscal_years(id),
          period_start   date NOT NULL,
          period_end     date NOT NULL,
          status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','locked'))
        )`);

      await client.query(`
        CREATE TABLE IF NOT EXISTS public.accounting_counters (
          name       text NOT NULL,
          year       integer NOT NULL,
          next_value integer NOT NULL DEFAULT 1,
          PRIMARY KEY (name, year)
        )`);

      await client.query(`
        CREATE TABLE IF NOT EXISTS public.accounting_audit_log (
          id          serial PRIMARY KEY,
          user_id     integer REFERENCES public.users(id) ON DELETE SET NULL,
          action      text NOT NULL,
          entity_type text NOT NULL,
          entity_id   integer,
          before_data jsonb,
          after_data  jsonb,
          created_at  timestamptz NOT NULL DEFAULT now()
        )`);

      // ---- ب) محرك القيود ----
      await client.query(`
        CREATE TABLE IF NOT EXISTS public.journal_entries (
          id                serial PRIMARY KEY,
          entry_date        date NOT NULL,
          source_type       text NOT NULL CHECK (source_type IN (
                              'invoice','credit_note','debit_note','receipt','purchase_invoice',
                              'expense','payment_out','payroll_run','fixed_asset_depreciation',
                              'fixed_asset_disposal','manual','reversal'
                            )),
          source_id         integer,
          reversed_entry_id integer REFERENCES public.journal_entries(id),
          description       text,
          is_manual         boolean NOT NULL DEFAULT false,
          created_by        integer REFERENCES public.users(id) ON DELETE SET NULL,
          created_at        timestamptz NOT NULL DEFAULT now()
        )`);
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS ux_journal_entries_source
        ON public.journal_entries (source_type, source_id)
        WHERE source_type NOT IN ('manual','reversal')`);

      await client.query(`
        CREATE TABLE IF NOT EXISTS public.journal_lines (
          id             serial PRIMARY KEY,
          entry_id       integer NOT NULL REFERENCES public.journal_entries(id) ON DELETE CASCADE,
          account_id     integer NOT NULL REFERENCES public.accounting_accounts(id),
          cost_center_id integer REFERENCES public.cost_centers(id),
          debit          numeric(14,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
          credit         numeric(14,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
          CONSTRAINT chk_debit_xor_credit CHECK (NOT (debit > 0 AND credit > 0))
        )`);
      await client.query(`CREATE INDEX IF NOT EXISTS ix_journal_lines_account ON public.journal_lines(account_id)`);
      await client.query(`CREATE INDEX IF NOT EXISTS ix_journal_lines_entry ON public.journal_lines(entry_id)`);

      // شبكة أمان: قيد غير متوازن لا يمكن أن يُحفظ (COMMIT) حتى لو تم تجاوز postJournalEntry يومًا ما.
      await client.query(`
        CREATE OR REPLACE FUNCTION public.fn_check_journal_balance() RETURNS trigger AS $$
        DECLARE d numeric; c numeric; eid integer;
        BEGIN
          eid := COALESCE(NEW.entry_id, OLD.entry_id);
          SELECT COALESCE(SUM(debit),0), COALESCE(SUM(credit),0) INTO d, c
            FROM public.journal_lines WHERE entry_id = eid;
          IF d <> c THEN
            RAISE EXCEPTION 'قيد محاسبي غير متوازن (entry_id=%): مدين % لا يساوي دائن %', eid, d, c;
          END IF;
          RETURN NULL;
        END; $$ LANGUAGE plpgsql`);
      await client.query(`DROP TRIGGER IF EXISTS trg_journal_balance ON public.journal_lines`);
      await client.query(`
        CREATE CONSTRAINT TRIGGER trg_journal_balance
        AFTER INSERT OR UPDATE OR DELETE ON public.journal_lines
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION public.fn_check_journal_balance()`);

      // ---- ربط اختياري بالقضايا (عمود إضافي فقط، لا يكسر شيء) ----
      await client.query(`ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS client_id integer REFERENCES public.clients(id)`);

      await client.query("COMMIT");
      console.log("✅ accounting: الجداول الأساسية ومحرك القيود جاهزة");
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("accounting bootstrap error:", e.message);
    } finally {
      client.release();
    }
  })();

  /* ---- زرع دليل الحسابات الافتراضي + الخدمات + سنة مالية حالية (مرة واحدة فقط) ---- */
  (async () => {
    try {
      await bootstrapDone; // لازم تنتظر إنشاء الجداول قبل الزرع فيها
      const acc = await pool.query(`SELECT 1 FROM public.accounting_accounts LIMIT 1`);
      if (!acc.rowCount) {
        const tree = [
          ["1000", "الأصول", "asset", null, null],
          ["1100", "الأصول المتداولة", "asset", "current_asset", "1000"],
          ["1110", "الصندوق", "asset", "cash", "1100"],
          ["1120", "البنوك", "asset", "bank", "1100"],
          ["1130", "العملاء", "asset", "accounts_receivable", "1100"],
          ["1140", "الذمم المدينة الأخرى", "asset", "other_receivable", "1100"],
          ["1200", "الأصول الثابتة", "asset", "fixed_asset", "1000"],
          ["1210", "مجمّع إهلاك الأصول الثابتة", "asset", "accumulated_depreciation", "1200"],
          ["2000", "الالتزامات", "liability", null, null],
          ["2100", "الموردون", "liability", "accounts_payable", "2000"],
          ["2200", "ضرائب مستحقة (ضريبة القيمة المضافة)", "liability", "tax_payable", "2000"],
          ["2300", "ضريبة مدخلات قابلة للخصم", "asset", "input_tax", "1100"],
          ["2400", "التزامات أخرى", "liability", "other_liability", "2000"],
          ["2410", "رواتب مستحقة الدفع", "liability", "payroll_payable", "2000"],
          ["3000", "حقوق الملكية", "equity", null, null],
          ["3100", "الأرباح المرحّلة", "equity", "retained_earnings", "3000"],
          ["4000", "الإيرادات", "revenue", null, null],
          ["4100", "إيرادات الخدمات القانونية", "revenue", "service_revenue", "4000"],
          ["4200", "إيرادات الاشتراكات", "revenue", "subscription_revenue", "4000"],
          ["4900", "إيرادات أخرى", "revenue", "other_revenue", "4000"],
          ["5000", "المصروفات", "expense", null, null],
          ["5100", "الرواتب", "expense", "salaries", "5000"],
          ["5200", "الإيجار", "expense", "rent", "5000"],
          ["5300", "البرامج", "expense", "software", "5000"],
          ["5400", "التسويق", "expense", "marketing", "5000"],
          ["5500", "الاتصالات", "expense", "communications", "5000"],
          ["5600", "مصروفات تشغيلية", "expense", "operating", "5000"],
          ["5700", "الإهلاك", "expense", "depreciation", "5000"],
          ["5900", "مصروفات أخرى", "expense", "other_expense", "5000"],
        ];
        const codeToId = {};
        for (const [code, name, type, subtype, parentCode] of tree) {
          const parentId = parentCode ? codeToId[parentCode] : null;
          const r = await pool.query(
            `INSERT INTO public.accounting_accounts (code, name, type, subtype, parent_id, is_system)
             VALUES ($1,$2,$3,$4,$5,true) RETURNING id`,
            [code, name, type, subtype, parentId]
          );
          codeToId[code] = r.rows[0].id;
        }
        console.log("✅ accounting: تم زرع دليل الحسابات الافتراضي");
      }

      const svc = await pool.query(`SELECT 1 FROM public.services LIMIT 1`);
      if (!svc.rowCount) {
        const defaults = ["استشارة", "صياغة عقد", "مراجعة عقد", "مذكرة قانونية", "وكالة", "تمثيل", "اشتراك", "باقة", "خدمة مخصصة"];
        for (const name of defaults) {
          await pool.query(`INSERT INTO public.services (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [name]);
        }
        console.log("✅ accounting: تم زرع قائمة الخدمات الافتراضية");
      }

      const fy = await pool.query(`SELECT id FROM public.fiscal_years WHERE year = $1`, [new Date().getFullYear()]);
      if (!fy.rowCount) {
        const year = new Date().getFullYear();
        const yr = await pool.query(
          `INSERT INTO public.fiscal_years (year, start_date, end_date, status)
           VALUES ($1, $2, $3, 'open') RETURNING id`,
          [year, `${year}-01-01`, `${year}-12-31`]
        );
        const fiscalYearId = yr.rows[0].id;
        for (let m = 1; m <= 12; m++) {
          const start = new Date(year, m - 1, 1);
          const end = new Date(year, m, 0);
          const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
          await pool.query(
            `INSERT INTO public.fiscal_periods (fiscal_year_id, period_start, period_end, status)
             VALUES ($1,$2,$3,'open')`,
            [fiscalYearId, iso(start), iso(end)]
          );
        }
        console.log("✅ accounting: تم إنشاء السنة المالية", year, "بـ12 فترة مفتوحة");
      }
    } catch (e) {
      console.error("accounting seed error:", e.message);
    }
  })();

  /* ===================== دوال مساعدة مشتركة ===================== */

  class PeriodClosedError extends Error {}

  async function assertPeriodOpen(client, entryDate) {
    const q = await client.query(
      `SELECT status FROM public.fiscal_periods WHERE $1 BETWEEN period_start AND period_end LIMIT 1`,
      [entryDate]
    );
    if (!q.rowCount) return; // لا فترة معرّفة لهذا التاريخ — لا نمنع (قد يكون تاريخ تأسيسي/تجريبي خارج النطاق المزروع)
    if (q.rows[0].status !== "open") throw new PeriodClosedError("الفترة المالية لهذا التاريخ مغلقة، لا يمكن الترحيل فيها.");
  }

  // المسار الوحيد المسموح به لإنشاء أي قيد محاسبي.
  // lines: [{ accountId, debit, credit, costCenterId }]
  async function postJournalEntry(client, { date, sourceType, sourceId, description, lines, userId, isManual, reversedEntryId }) {
    await assertPeriodOpen(client, date);

    const totalDebit = lines.reduce((s, l) => s + Number(l.debit || 0), 0);
    const totalCredit = lines.reduce((s, l) => s + Number(l.credit || 0), 0);
    const round2 = (n) => Math.round(n * 100) / 100;
    if (round2(totalDebit) !== round2(totalCredit)) {
      throw new Error(`قيد غير متوازن: مدين ${totalDebit} لا يساوي دائن ${totalCredit}`);
    }
    if (!lines.length) throw new Error("لا يمكن إنشاء قيد بدون سطور");

    const entryRes = await client.query(
      `INSERT INTO public.journal_entries (entry_date, source_type, source_id, reversed_entry_id, description, is_manual, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [date, sourceType, sourceId || null, reversedEntryId || null, description || null, !!isManual, userId || null]
    );
    const entryId = entryRes.rows[0].id;

    for (const l of lines) {
      await client.query(
        `INSERT INTO public.journal_lines (entry_id, account_id, cost_center_id, debit, credit)
         VALUES ($1,$2,$3,$4,$5)`,
        [entryId, l.accountId, l.costCenterId || null, Number(l.debit || 0), Number(l.credit || 0)]
      );
    }
    return entryId;
  }

  // قيد عكسي كامل لقيد قائم (بدل حذفه) — يُستخدم عند إلغاء فاتورة/مصروف معتمد.
  async function reverseJournalEntry(client, entryId, { date, description, userId }) {
    const lines = await client.query(`SELECT account_id, cost_center_id, debit, credit FROM public.journal_lines WHERE entry_id = $1`, [entryId]);
    if (!lines.rowCount) return null;
    const reversed = lines.rows.map((l) => ({
      accountId: l.account_id,
      costCenterId: l.cost_center_id,
      debit: Number(l.credit),
      credit: Number(l.debit),
    }));
    return postJournalEntry(client, {
      date, sourceType: "reversal", sourceId: null, reversedEntryId: entryId,
      description: description || "قيد عكسي", lines: reversed, userId, isManual: false,
    });
  }

  // ترقيم تسلسلي آمن تحت التزامن — يُستدعى داخل نفس ترانزاكشن إنشاء المستند.
  async function nextDocNumber(client, name, prefix) {
    const year = new Date().getFullYear();
    await client.query(
      `INSERT INTO public.accounting_counters (name, year, next_value) VALUES ($1,$2,1)
       ON CONFLICT (name, year) DO NOTHING`,
      [name, year]
    );
    const q = await client.query(
      `SELECT next_value FROM public.accounting_counters WHERE name=$1 AND year=$2 FOR UPDATE`,
      [name, year]
    );
    const n = q.rows[0].next_value;
    await client.query(`UPDATE public.accounting_counters SET next_value = next_value + 1 WHERE name=$1 AND year=$2`, [name, year]);
    return `${prefix}-${year}-${String(n).padStart(5, "0")}`;
  }

  async function auditLog(client, { userId, action, entityType, entityId, before, after }) {
    await (client || pool).query(
      `INSERT INTO public.accounting_audit_log (user_id, action, entity_type, entity_id, before_data, after_data)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [userId || null, action, entityType, entityId || null, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]
    );
  }

  async function currentVatRate() {
    const q = await pool.query(
      `SELECT vat_rate FROM public.accounting_tax_settings WHERE effective_from <= CURRENT_DATE ORDER BY effective_from DESC LIMIT 1`
    );
    return q.rowCount ? Number(q.rows[0].vat_rate) : 15;
  }

  async function getAccountByCode(client, code) {
    const q = await (client || pool).query(`SELECT id FROM public.accounting_accounts WHERE code = $1`, [code]);
    return q.rowCount ? q.rows[0].id : null;
  }

  // نتيح هذه الدوال للأجزاء اللاحقة (الفواتير/المصروفات/الرواتب/الأصول) عبر app.locals
  // بدل تصديرها كملف منفصل — يبقي كل شيء داخل نفس mountAccounting() ويُسهّل الصيانة لاحقًا.
  const ctx = { auth, roleOf, isManager, requireManager, postJournalEntry, reverseJournalEntry, nextDocNumber, auditLog, currentVatRate, getAccountByCode, assertPeriodOpen, PeriodClosedError, bootstrapDone };
  app.locals.accounting = ctx;

  mountAR(app, pool, ctx);
  mountAP(app, pool, ctx);
  mountBank(app, pool, ctx);
  mountPayroll(app, pool, ctx);
  mountAssets(app, pool, ctx);
  mountReports(app, pool, ctx);
  mountPeriods(app, pool, ctx);

  /* ===================== مسارات دليل الحسابات ===================== */
  app.get("/accounting/accounts", auth, requireManager, async (req, res) => {
    try {
      const q = await pool.query(`SELECT id, code, name, type, subtype, parent_id AS "parentId", is_system AS "isSystem", active FROM public.accounting_accounts ORDER BY code`);
      res.json(q.rows);
    } catch (e) {
      console.error("GET /accounting/accounts:", e);
      res.status(500).json({ error: "server_error" });
    }
  });

  app.post("/accounting/accounts", auth, requireManager, async (req, res) => {
    try {
      const { code, name, type, subtype, parentId } = req.body || {};
      if (!code || !name || !["asset", "liability", "equity", "revenue", "expense"].includes(type)) {
        return res.status(400).json({ error: "bad_input" });
      }
      const q = await pool.query(
        `INSERT INTO public.accounting_accounts (code, name, type, subtype, parent_id, is_system)
         VALUES ($1,$2,$3,$4,$5,false) RETURNING id, code, name, type, subtype, parent_id AS "parentId", is_system AS "isSystem", active`,
        [String(code).trim(), String(name).trim(), type, subtype || null, parentId || null]
      );
      await auditLog(null, { userId: req.user.id, action: "account.create", entityType: "accounting_accounts", entityId: q.rows[0].id, after: q.rows[0] });
      res.status(201).json(q.rows[0]);
    } catch (e) {
      if (e.code === "23505") return res.status(409).json({ error: "code_taken" });
      console.error("POST /accounting/accounts:", e);
      res.status(500).json({ error: "server_error" });
    }
  });

  app.patch("/accounting/accounts/:id", auth, requireManager, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const cur = await pool.query(`SELECT * FROM public.accounting_accounts WHERE id=$1`, [id]);
      if (!cur.rowCount) return res.status(404).json({ error: "not_found" });
      const { name, active } = req.body || {};
      const q = await pool.query(
        `UPDATE public.accounting_accounts SET name = COALESCE($1,name), active = COALESCE($2,active) WHERE id=$3
         RETURNING id, code, name, type, subtype, parent_id AS "parentId", is_system AS "isSystem", active`,
        [name || null, typeof active === "boolean" ? active : null, id]
      );
      await auditLog(null, { userId: req.user.id, action: "account.update", entityType: "accounting_accounts", entityId: id, before: cur.rows[0], after: q.rows[0] });
      res.json(q.rows[0]);
    } catch (e) {
      console.error("PATCH /accounting/accounts/:id:", e);
      res.status(500).json({ error: "server_error" });
    }
  });

  /* ===================== مسارات مساعدة رفيعة: عملاء / موردون / خدمات / مراكز تكلفة ===================== */
  function simpleCrud(path, table, fields) {
    // fields: [{col, key, required}] — يبني GET/POST/PATCH رفيعة بنفس النمط لكل مورد بسيط.
    app.get(`/accounting/${path}`, auth, requireManager, async (req, res) => {
      try {
        const cols = fields.map((f) => `${f.col} AS "${f.key}"`).join(", ");
        const q = await pool.query(`SELECT id, ${cols}, created_at AS "createdAt" FROM public.${table} ORDER BY id DESC`);
        res.json(q.rows);
      } catch (e) {
        console.error(`GET /accounting/${path}:`, e);
        res.status(500).json({ error: "server_error" });
      }
    });

    app.post(`/accounting/${path}`, auth, requireManager, async (req, res) => {
      try {
        for (const f of fields) {
          if (f.required && !String(req.body?.[f.key] || "").trim()) return res.status(400).json({ error: "missing_" + f.key });
        }
        const cols = fields.map((f) => f.col).join(", ");
        const placeholders = fields.map((_, i) => `$${i + 1}`).join(", ");
        const vals = fields.map((f) => (req.body?.[f.key] !== undefined ? req.body[f.key] : null));
        const retCols = fields.map((f) => `${f.col} AS "${f.key}"`).join(", ");
        const q = await pool.query(
          `INSERT INTO public.${table} (${cols}) VALUES (${placeholders}) RETURNING id, ${retCols}, created_at AS "createdAt"`,
          vals
        );
        await auditLog(null, { userId: req.user.id, action: `${table}.create`, entityType: table, entityId: q.rows[0].id, after: q.rows[0] });
        res.status(201).json(q.rows[0]);
      } catch (e) {
        console.error(`POST /accounting/${path}:`, e);
        res.status(500).json({ error: "server_error" });
      }
    });

    app.patch(`/accounting/${path}/:id`, auth, requireManager, async (req, res) => {
      try {
        const id = Number(req.params.id);
        const cur = await pool.query(`SELECT * FROM public.${table} WHERE id=$1`, [id]);
        if (!cur.rowCount) return res.status(404).json({ error: "not_found" });
        const sets = [];
        const vals = [];
        fields.forEach((f) => {
          if (req.body?.[f.key] !== undefined) {
            vals.push(req.body[f.key]);
            sets.push(`${f.col} = $${vals.length}`);
          }
        });
        if (table === "clients" || table === "vendors") sets.push(`updated_at = now()`);
        if (!sets.length) return res.json(cur.rows[0]);
        vals.push(id);
        const retCols = fields.map((f) => `${f.col} AS "${f.key}"`).join(", ");
        const q = await pool.query(
          `UPDATE public.${table} SET ${sets.join(", ")} WHERE id = $${vals.length} RETURNING id, ${retCols}, created_at AS "createdAt"`,
          vals
        );
        await auditLog(null, { userId: req.user.id, action: `${table}.update`, entityType: table, entityId: id, before: cur.rows[0], after: q.rows[0] });
        res.json(q.rows[0]);
      } catch (e) {
        console.error(`PATCH /accounting/${path}/:id:`, e);
        res.status(500).json({ error: "server_error" });
      }
    });
  }

  simpleCrud("clients", "clients", [
    { col: "name", key: "name", required: true },
    { col: "type", key: "type" },
    { col: "tax_number", key: "taxNumber" },
    { col: "commercial_registration", key: "commercialRegistration" },
    { col: "email", key: "email" },
    { col: "phone", key: "phone" },
    { col: "billing_address", key: "billingAddress" },
    { col: "notes", key: "notes" },
  ]);

  simpleCrud("vendors", "vendors", [
    { col: "name", key: "name", required: true },
    { col: "tax_number", key: "taxNumber" },
    { col: "commercial_registration", key: "commercialRegistration" },
    { col: "email", key: "email" },
    { col: "phone", key: "phone" },
    { col: "address", key: "address" },
    { col: "notes", key: "notes" },
  ]);

  simpleCrud("services", "services", [
    { col: "name", key: "name", required: true },
    { col: "default_price", key: "defaultPrice" },
    { col: "active", key: "active" },
  ]);

  simpleCrud("cost-centers", "cost_centers", [
    { col: "name", key: "name", required: true },
    { col: "kind", key: "kind" },
    { col: "active", key: "active" },
  ]);

  /* ===================== إعدادات الضريبة ===================== */
  app.get("/accounting/tax-settings", auth, requireManager, async (req, res) => {
    try {
      const q = await pool.query(`SELECT id, vat_rate AS "vatRate", effective_from AS "effectiveFrom" FROM public.accounting_tax_settings ORDER BY effective_from DESC`);
      res.json(q.rows);
    } catch (e) {
      console.error("GET /accounting/tax-settings:", e);
      res.status(500).json({ error: "server_error" });
    }
  });

  app.post("/accounting/tax-settings", auth, requireManager, async (req, res) => {
    try {
      const rate = Number(req.body?.vatRate);
      const from = req.body?.effectiveFrom ? String(req.body.effectiveFrom) : null;
      if (!Number.isFinite(rate) || rate < 0 || !from) return res.status(400).json({ error: "bad_input" });
      const q = await pool.query(
        `INSERT INTO public.accounting_tax_settings (vat_rate, effective_from) VALUES ($1,$2)
         RETURNING id, vat_rate AS "vatRate", effective_from AS "effectiveFrom"`,
        [rate, from]
      );
      await auditLog(null, { userId: req.user.id, action: "tax_settings.create", entityType: "accounting_tax_settings", entityId: q.rows[0].id, after: q.rows[0] });
      res.status(201).json(q.rows[0]);
    } catch (e) {
      console.error("POST /accounting/tax-settings:", e);
      res.status(500).json({ error: "server_error" });
    }
  });

  /* ===================== دفتر الأستاذ + ميزان المراجعة ===================== */
  app.get("/accounting/ledger/:accountId", auth, requireManager, async (req, res) => {
    try {
      const accountId = Number(req.params.accountId);
      const q = await pool.query(
        `SELECT jl.id, je.entry_date AS "date", je.source_type AS "sourceType", je.source_id AS "sourceId",
                je.description, jl.debit, jl.credit
           FROM public.journal_lines jl
           JOIN public.journal_entries je ON je.id = jl.entry_id
          WHERE jl.account_id = $1
          ORDER BY je.entry_date, jl.id`,
        [accountId]
      );
      let balance = 0;
      const rows = q.rows.map((r) => {
        balance += Number(r.debit) - Number(r.credit);
        return { ...r, runningBalance: balance };
      });
      res.json(rows);
    } catch (e) {
      console.error("GET /accounting/ledger/:accountId:", e);
      res.status(500).json({ error: "server_error" });
    }
  });

  app.get("/accounting/trial-balance", auth, requireManager, async (req, res) => {
    try {
      const q = await pool.query(`
        SELECT a.id, a.code, a.name, a.type,
               COALESCE(SUM(jl.debit),0) AS debit,
               COALESCE(SUM(jl.credit),0) AS credit
          FROM public.accounting_accounts a
          LEFT JOIN public.journal_lines jl ON jl.account_id = a.id
         GROUP BY a.id, a.code, a.name, a.type
         ORDER BY a.code`);
      const rows = q.rows.map((r) => ({
        id: r.id, code: r.code, name: r.name, type: r.type,
        debit: Number(r.debit), credit: Number(r.credit), balance: Number(r.debit) - Number(r.credit),
      }));
      const totalDebit = rows.reduce((s, r) => s + r.debit, 0);
      const totalCredit = rows.reduce((s, r) => s + r.credit, 0);
      res.json({ rows, totalDebit, totalCredit, balanced: Math.round(totalDebit * 100) === Math.round(totalCredit * 100) });
    } catch (e) {
      console.error("GET /accounting/trial-balance:", e);
      res.status(500).json({ error: "server_error" });
    }
  });

  /* ===================== قيود يدوية (استثنائية فقط) ===================== */
  app.get("/accounting/journal-entries", auth, requireManager, async (req, res) => {
    try {
      const q = await pool.query(`
        SELECT je.id, je.entry_date AS "date", je.source_type AS "sourceType", je.source_id AS "sourceId",
               je.description, je.is_manual AS "isManual",
               COALESCE(json_agg(json_build_object('accountId', jl.account_id, 'debit', jl.debit, 'credit', jl.credit)) FILTER (WHERE jl.id IS NOT NULL), '[]') AS lines
          FROM public.journal_entries je
          LEFT JOIN public.journal_lines jl ON jl.entry_id = je.id
         GROUP BY je.id
         ORDER BY je.entry_date DESC, je.id DESC
         LIMIT 200`);
      res.json(q.rows);
    } catch (e) {
      console.error("GET /accounting/journal-entries:", e);
      res.status(500).json({ error: "server_error" });
    }
  });

  app.post("/accounting/journal-entries", auth, requireManager, async (req, res) => {
    const client = await pool.connect();
    try {
      const { date, description, lines } = req.body || {};
      if (!date || !Array.isArray(lines) || lines.length < 2) return res.status(400).json({ error: "bad_input" });
      await client.query("BEGIN");
      const entryId = await postJournalEntry(client, {
        date, sourceType: "manual", sourceId: null, description: description || "قيد يدوي",
        lines: lines.map((l) => ({ accountId: Number(l.accountId), debit: Number(l.debit || 0), credit: Number(l.credit || 0), costCenterId: l.costCenterId || null })),
        userId: req.user.id, isManual: true,
      });
      await auditLog(client, { userId: req.user.id, action: "journal_entry.manual_create", entityType: "journal_entries", entityId: entryId, after: req.body });
      await client.query("COMMIT");
      res.status(201).json({ id: entryId });
    } catch (e) {
      await client.query("ROLLBACK");
      if (e instanceof PeriodClosedError) return res.status(409).json({ error: e.message });
      console.error("POST /accounting/journal-entries:", e);
      res.status(400).json({ error: e.message || "server_error" });
    } finally {
      client.release();
    }
  });

  console.log("✅ accounting routes mounted (accounts / clients / vendors / services / cost-centers / tax-settings / ledger / trial-balance / journal-entries)");
}
