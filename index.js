// FILE: C:\faris-api\index.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import pkg from "pg";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { upload } from "./upload.js";

const { Pool } = pkg;

/* =====================================================
   App setup
===================================================== */
const app = express();

// ✅ CORS مضبوط (يدعم localhost + دومين موقعك)
const ORIGINS = (
  process.env.CORS_ORIGINS ||
  "http://localhost:5173,http://localhost:3000,https://www.faris-legal.com,https://faris-legal.com,https://faris-legal.onrender.com"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      // أدوات مثل PowerShell/curl ما ترسل Origin
      if (!origin) return cb(null, true);
      if (ORIGINS.includes(origin)) return cb(null, true);
      // لا نرمي Error قوي يسبب 500 غامض — نخليها Forbidden واضحة
      return cb(null, false);
    },
    credentials: true,
  })
);

app.use(express.json({ limit: "10mb" }));

// __dirname for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ensure uploads folder exists
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// serve uploaded files
app.use("/uploads", express.static(uploadsDir));

// serve built frontend (single-domain)
const publicDir = path.join(__dirname, "public");
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}

/* =====================================================
   DB
===================================================== */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// ✅ اجبار السيرفر يستخدم public أولاً (لكن ما يمنعنا نجرب app عند الحاجة)
pool.on("connect", (client) => {
  client.query("SET search_path TO public, app").catch(() => {});
});

pool
  .connect()
  .then((c) => {
    console.log("✅ Connected to Postgres");
    c.release();
  })
  .catch((e) => console.error("❌ DB error:", e.message));

pool
  .query(
    "SELECT current_database() db, inet_server_addr() addr, inet_server_port() port, current_user usr"
  )
  .then((r) => console.log("🧠 DB INFO:", r.rows[0]))
  .catch((e) => console.log("🧠 DB INFO error:", e.message));

/* =====================================================
   Helpers
===================================================== */
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-faris";

// ✅ توحيد role
function roleOf(u) {
  return String(u?.role || "").trim().toLowerCase();
}

function mustBeManager(req, res) {
  if (roleOf(req.user) !== "manager") {
    res.status(403).json({ error: "forbidden" });
    return false;
  }
  return true;
}

function mustBeStaff(req, res) {
  if (roleOf(req.user) !== "staff") {
    res.status(403).json({ error: "forbidden" });
    return false;
  }
  return true;
}

function isMissingTable(err) {
  return err?.code === "42P01"; // undefined_table
}

function isMissingColumn(err) {
  return err?.code === "42703"; // undefined_column
}

/* =====================================================
   🔥 Active Column Resolver (per schema)
===================================================== */
const __activeColCache = new Map();

/**
 * يرجع اسم عمود التفعيل الموجود في schema محدد:
 * - public.users قد يحتوي active أو is_active
 * - app.users عندك يحتوي is_active
 */
async function getActiveCol(schema = "public") {
  const key = String(schema || "public");
  if (__activeColCache.has(key)) return __activeColCache.get(key);

  let col = "is_active"; // default safe
  try {
    const q = await pool.query(
      `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema=$1
        AND table_name='users'
        AND column_name IN ('is_active','active')
      `,
      [key]
    );

    const cols = (q.rows || []).map((r) => String(r.column_name));
    if (cols.includes("is_active")) col = "is_active";
    else if (cols.includes("active")) col = "active";
  } catch {
    // ignore
  }

  __activeColCache.set(key, col);
  return col;
}

/* =====================================================
   Auth middleware
===================================================== */
function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "no_token" });

  try {
    req.user = jwt.verify(token, JWT_SECRET); // {id, role}
    next();
  } catch {
    return res.status(401).json({ error: "invalid_or_expired" });
  }
}

/* =====================================================
   Access helper (manager OR assigned staff)
===================================================== */
async function canAccessCase(caseId, user) {
  if (!user) return false;
  if (roleOf(user) === "manager") return true;

  const q = await pool.query(
    `SELECT 1 FROM assignments WHERE case_id=$1 AND user_id=$2 LIMIT 1`,
    [Number(caseId), Number(user.id)]
  );
  return q.rowCount > 0;
}

/* =====================================================
   Health ✅
===================================================== */
app.get("/health", async (_, res) => {
  try {
    const q = await pool.query(
      `SELECT current_database() AS db, inet_server_addr() AS addr, inet_server_port() AS port, current_user AS usr, current_setting('search_path') AS sp`
    );
    const activePublic = await getActiveCol("public");
    const activeApp = await getActiveCol("app");
    return res.json({
      ok: true,
      pid: process.pid,
      file: __filename,
      active: { public: activePublic, app: activeApp },
      db: q.rows[0],
    });
  } catch (e) {
    return res.json({
      ok: true,
      pid: process.pid,
      file: __filename,
      db_error: e.message,
    });
  }
});

/* =====================================================
   Auth helpers (find user in public then app)
===================================================== */
async function findUserByEmail(emailNorm) {
  // 1) public
  try {
    const activeCol = await getActiveCol("public");
    const q = await pool.query(
      `
      SELECT id, password_hash, role, ${activeCol} AS is_active
      FROM public.users
      WHERE lower(email)=lower($1)
      LIMIT 1
      `,
      [emailNorm]
    );
    if (q.rowCount) return { schema: "public", user: q.rows[0] };
  } catch (e) {
    // لو public.users فيها مشكلة، نكمل نجرب app
    if (!isMissingTable(e) && !isMissingColumn(e)) throw e;
  }

  // 2) app
  try {
    const activeCol = await getActiveCol("app");
    const q = await pool.query(
      `
      SELECT id, password_hash, role, ${activeCol} AS is_active
      FROM app.users
      WHERE lower(email)=lower($1)
      LIMIT 1
      `,
      [emailNorm]
    );
    if (q.rowCount) return { schema: "app", user: q.rows[0] };
  } catch (e) {
    if (!isMissingTable(e) && !isMissingColumn(e)) throw e;
  }

  return null;
}

async function findMeById(id) {
  const idStr = String(id ?? "").trim();
  if (!idStr) return null;

  // نجرب public ثم app (يدعم int/uuid لأننا نقارن id::text)
  try {
    const q = await pool.query(
      `SELECT id, email, full_name, role FROM public.users WHERE id::text=$1 LIMIT 1`,
      [idStr]
    );
    if (q.rowCount) return q.rows[0];
  } catch (e) {
    if (!isMissingTable(e) && !isMissingColumn(e)) throw e;
  }

  try {
    const q = await pool.query(
      `SELECT id, email, full_name, role FROM app.users WHERE id::text=$1 LIMIT 1`,
      [idStr]
    );
    if (q.rowCount) return q.rows[0];
  } catch (e) {
    if (!isMissingTable(e) && !isMissingColumn(e)) throw e;
  }

  return null;
}

/* =====================================================
   Auth (نسخة واحدة فقط ✅)
===================================================== */
app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const emailNorm = String(email || "").trim();
    const passNorm = String(password || "").trim();

    if (!emailNorm || !passNorm) {
      return res.status(400).json({ error: "missing_credentials" });
    }

    const found = await findUserByEmail(emailNorm);
    if (!found?.user) return res.status(400).json({ error: "invalid_credentials" });

    const user = found.user;

    const isActive = (user.is_active ?? true) === true;
    if (!isActive) return res.status(403).json({ error: "inactive" });

    const hash = user.password_hash ? String(user.password_hash) : "";
    const ok = await bcrypt.compare(passNorm, hash);
    if (!ok) return res.status(400).json({ error: "invalid_credentials" });

    // ✅ نخزن id كـ string (يدعم int/uuid)
    const token = jwt.sign(
      { id: String(user.id), role: String(user.role || "").trim().toLowerCase() },
      JWT_SECRET,
      { expiresIn: "8h" }
    );

    return res.json({ token });
  } catch (e) {
    console.error("POST /auth/login:", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

app.get("/me", auth, async (req, res) => {
  try {
    const me = await findMeById(req.user?.id);
    if (!me) return res.status(404).json({ error: "user_not_found" });
    return res.json(me);
  } catch (e) {
    console.error("GET /me:", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

/* =====================================================
   Auth Register (staff pending by default) -> public.users
===================================================== */
app.post("/auth/register", async (req, res) => {
  try {
    const full_name = String(req.body?.full_name || req.body?.name || "").trim();
    const email = String(req.body?.email || "").trim();
    const password = String(req.body?.password || "").trim();

    if (!full_name) return res.status(400).json({ error: "full_name_required" });
    if (!email) return res.status(400).json({ error: "email_required" });
    if (!password) return res.status(400).json({ error: "password_required" });

    const exists = await pool.query(
      `SELECT 1 FROM public.users WHERE lower(email)=lower($1) LIMIT 1`,
      [email]
    );
    if (exists.rowCount) return res.status(409).json({ error: "email_exists" });

    const password_hash = await bcrypt.hash(password, 10);
    const activeCol = await getActiveCol("public");

    const q = await pool.query(
      `
      INSERT INTO public.users (full_name, email, password_hash, role, ${activeCol}, created_at)
      VALUES ($1, $2, $3, 'staff', false, NOW())
      RETURNING id, full_name, email, role, ${activeCol} AS is_active
      `,
      [full_name, email, password_hash]
    );

    return res.status(201).json({ ok: true, user: q.rows[0] });
  } catch (e) {
    console.error("POST /auth/register:", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

/* =====================================================
   Auth Pending (manager) -> public.users
===================================================== */
app.get("/auth/pending", auth, async (req, res) => {
  try {
    if (!mustBeManager(req, res)) return;

    const activeCol = await getActiveCol("public");

    const q = await pool.query(
      `
      SELECT id, email, full_name, role, ${activeCol} AS is_active, created_at
      FROM public.users
      WHERE ${activeCol} = false
      ORDER BY created_at DESC NULLS LAST
      `
    );
    return res.json(q.rows || []);
  } catch (e) {
    console.error("GET /auth/pending:", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

/* =====================================================
   Auth Approve (manager) -> public.users
===================================================== */
app.post("/auth/approve", auth, async (req, res) => {
  try {
    if (!mustBeManager(req, res)) return;

    const userId = req.body?.userId || req.body?.id || req.body?.user_id;
    const idStr = String(userId || "").trim();
    if (!idStr) return res.status(400).json({ error: "invalid_user_id" });

    const activeCol = await getActiveCol("public");

    const q = await pool.query(
      `
      UPDATE public.users
      SET ${activeCol}=true
      WHERE id::text=$1
      RETURNING id, full_name, email, role, ${activeCol} AS is_active
      `,
      [idStr]
    );
    if (!q.rowCount) return res.status(404).json({ error: "not_found" });
    return res.json({ ok: true, user: q.rows[0] });
  } catch (e) {
    console.error("POST /auth/approve:", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

/* =====================================================
   Auth Reject (manager) -> public.users
===================================================== */
app.post("/auth/reject", auth, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!mustBeManager(req, res)) return;

    const userId = req.body?.userId ?? req.body?.user_id ?? req.body?.id;
    const idStr = String(userId || "").trim();
    if (!idStr) return res.status(400).json({ error: "userId_required" });

    const activeCol = await getActiveCol("public");

    const r = await client.query(
      `UPDATE public.users SET ${activeCol}=false WHERE id::text=$1 AND role='staff' RETURNING id`,
      [idStr]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: "not_found" });

    return res.json({ ok: true });
  } catch (e) {
    console.error("POST /auth/reject error:", e.message);
    return res.status(500).json({ error: "server_error" });
  } finally {
    client.release();
  }
});

/* =====================================================
   Employees (Manager) -> public.users
===================================================== */
app.get("/employees", auth, async (req, res) => {
  try {
    if (!mustBeManager(req, res)) return;

    const activeCol = await getActiveCol("public");

    const q = await pool.query(`
      SELECT id, full_name, email, role, ${activeCol} AS is_active
      FROM public.users
      WHERE role IN ('staff','manager')
      ORDER BY role DESC
    `);

    return res.json(q.rows || []);
  } catch (e) {
    console.error("GET /employees error:", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

app.patch("/employees/:id/active", auth, async (req, res) => {
  try {
    if (!mustBeManager(req, res)) return;

    const idStr = String(req.params.id || "").trim();
    const active = !!req.body?.active;
    if (!idStr) return res.status(400).json({ error: "invalid_id" });

    const activeCol = await getActiveCol("public");

    const q = await pool.query(
      `UPDATE public.users SET ${activeCol}=$1 WHERE id::text=$2 RETURNING id, full_name, email, role, ${activeCol} AS is_active`,
      [active, idStr]
    );
    if (!q.rowCount) return res.status(404).json({ error: "not_found" });
    return res.json({ ok: true, user: q.rows[0] });
  } catch (e) {
    console.error("PATCH /employees/:id/active error:", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

/* =====================================================
   Assign (manager)
===================================================== */
app.post("/assign", auth, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!mustBeManager(req, res)) return;

    const { case_id, user_id, note } = req.body || {};
    const caseId = Number(case_id);
    const userId = Number(user_id);
    if (!caseId || !userId) return res.status(400).json({ error: "invalid_ids" });

    await client.query("BEGIN");

    const caseExists = await client.query(`SELECT 1 FROM cases WHERE id=$1`, [caseId]);
    if (caseExists.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "case_not_found" });
    }

    const activeCol = await getActiveCol("public");

    const uRow = await client.query(
      `SELECT role, ${activeCol} AS is_active FROM public.users WHERE id=$1`,
      [userId]
    );
    if (uRow.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "user_not_found" });
    }

    const role = String(uRow.rows[0].role || "").toLowerCase();
    if (role !== "staff") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "assignee_must_be_staff" });
    }

    const isActive = (uRow.rows[0].is_active ?? true) === true;
    if (!isActive) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "assignee_not_active" });
    }

    await client.query(`DELETE FROM assignments WHERE case_id=$1`, [caseId]);

    await client.query(
      `
      INSERT INTO assignments (case_id, user_id, note, assigned_by, assigned_at)
      VALUES ($1,$2,$3,$4,NOW())
      `,
      [caseId, userId, note || null, String(req.user.id)]
    );

    try {
      await client.query(
        `INSERT INTO activity_log (case_id, who, what) VALUES ($1,$2,$3)`,
        [caseId, String(req.user.id), `إسناد القضية للموظف #${userId}`]
      );
    } catch {}

    await client.query("COMMIT");
    return res.json({ ok: true });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("POST /assign error:", e.message);
    return res.status(500).json({ error: "server_error" });
  } finally {
    client.release();
  }
});

/* =====================================================
   SPA fallback (frontend)
===================================================== */
if (fs.existsSync(publicDir)) {
  app.get("/", (req, res) => {
    return res.sendFile(path.join(publicDir, "index.html"));
  });

  app.get("*", (req, res, next) => {
    if (
      req.path.startsWith("/auth") ||
      req.path.startsWith("/cases") ||
      req.path.startsWith("/employees") ||
      req.path.startsWith("/assign") ||
      req.path.startsWith("/my") ||
      req.path.startsWith("/drafts") ||
      req.path.startsWith("/notifications") ||
      req.path.startsWith("/activity") ||
      req.path.startsWith("/sessions") ||
      req.path.startsWith("/uploads") ||
      req.path.startsWith("/health")
    ) {
      return next();
    }
    return res.sendFile(path.join(publicDir, "index.html"));
  });
}

/* =====================================================
   Fallback 404 (MUST BE LAST)
===================================================== */
app.use((req, res) => {
  res.status(404).json({ error: "not_found" });
});

/* =====================================================
   Start
===================================================== */
const PORT = process.env.PORT || 3003;
app.listen(PORT, () => console.log("🚀 API running on port " + PORT));
