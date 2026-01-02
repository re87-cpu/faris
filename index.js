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
import { upload } from "./upload.js"; // keep (حتى لو مو مستخدم هنا)

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
      if (!origin) return cb(null, true); // curl/VScode/Server-to-server
      if (ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
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

// ✅ نخلي search_path يفضل public لكن ما يمنعنا نقرأ من app عند الحاجة
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
  return err?.code === "42P01";
}

function isMissingColumn(err) {
  return err?.code === "42703";
}

/* =====================================================
   Active Column Resolver (public.users)
===================================================== */
let __activeColCache = null;

async function getActiveColPublic() {
  if (__activeColCache) return __activeColCache;

  try {
    const q = await pool.query(
      `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema='public'
        AND table_name='users'
        AND column_name IN ('is_active','active')
      `
    );
    const cols = (q.rows || []).map((r) => String(r.column_name));
    if (cols.includes("is_active")) __activeColCache = "is_active";
    else if (cols.includes("active")) __activeColCache = "active";
    else __activeColCache = "is_active";
  } catch {
    __activeColCache = "is_active";
  }

  return __activeColCache;
}

/* =====================================================
   Auth middleware
===================================================== */
function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "no_token" });

  try {
    req.user = jwt.verify(token, JWT_SECRET); // {id, role, schema?}
    next();
  } catch {
    return res.status(401).json({ error: "invalid_or_expired" });
  }
}

/* =====================================================
   Users helpers (try public then app)
   - important: id is returned as TEXT always to avoid uuid/int issues
===================================================== */
async function findUserByEmail(emailNorm) {
  // 1) public.users (might be int id)
  try {
    const activeCol = await getActiveColPublic();
    const q = await pool.query(
      `
      SELECT
        id::text AS id,
        email,
        full_name,
        password_hash,
        role,
        ${activeCol} AS is_active,
        'public'::text AS schema
      FROM public.users
      WHERE lower(email)=lower($1)
      LIMIT 1
      `,
      [emailNorm]
    );
    if (q.rowCount) return q.rows[0];
  } catch (e) {
    console.log("DEBUG findUser public:", e.message);
  }

  // 2) app.users (uuid id)
  try {
    const q2 = await pool.query(
      `
      SELECT
        id::text AS id,
        email,
        full_name,
        password_hash,
        role,
        is_active AS is_active,
        'app'::text AS schema
      FROM app.users
      WHERE lower(email)=lower($1)
      LIMIT 1
      `,
      [emailNorm]
    );
    if (q2.rowCount) return q2.rows[0];
  } catch (e) {
    console.log("DEBUG findUser app:", e.message);
  }

  return null;
}

async function findUserByIdText(idText) {
  // public first
  try {
    const activeCol = await getActiveColPublic();
    const q = await pool.query(
      `
      SELECT
        id::text AS id,
        email,
        full_name,
        role,
        ${activeCol} AS is_active,
        'public'::text AS schema
      FROM public.users
      WHERE id::text=$1
      LIMIT 1
      `,
      [idText]
    );
    if (q.rowCount) return q.rows[0];
  } catch (e) {
    // ignore
  }

  // app
  try {
    const q2 = await pool.query(
      `
      SELECT
        id::text AS id,
        email,
        full_name,
        role,
        is_active AS is_active,
        'app'::text AS schema
      FROM app.users
      WHERE id::text=$1
      LIMIT 1
      `,
      [idText]
    );
    if (q2.rowCount) return q2.rows[0];
  } catch (e) {
    // ignore
  }

  return null;
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
      `
      SELECT current_database() AS db,
             inet_server_addr() AS addr,
             inet_server_port() AS port,
             current_user AS usr,
             current_setting('search_path') AS sp
      `
    );

    return res.json({
      ok: true,
      version: "health-v4-2026-01-02",
      pid: process.pid,
      file: __filename,
      db: q.rows[0],
    });
  } catch (e) {
    return res.json({
      ok: false,
      version: "health-v4-2026-01-02",
      error: e.message,
    });
  }
});

/* =====================================================
   Auth
===================================================== */
app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const emailNorm = String(email || "").trim();
    const passNorm = String(password || "").trim();

    if (!emailNorm || !passNorm) {
      return res.status(400).json({ error: "missing_credentials" });
    }

    const user = await findUserByEmail(emailNorm);
    if (!user) return res.status(400).json({ error: "invalid_credentials" });

    const isActive = (user.is_active ?? true) === true;
    if (!isActive) return res.status(403).json({ error: "inactive" });

    const hash = user.password_hash ? String(user.password_hash) : "";
    const ok = await bcrypt.compare(passNorm, hash);
    if (!ok) return res.status(400).json({ error: "invalid_credentials" });

    const token = jwt.sign(
      { id: String(user.id), role: roleOf(user), schema: user.schema },
      JWT_SECRET,
      { expiresIn: "8h" }
    );

    return res.json({ token });
  } catch (e) {
    console.error("POST /auth/login:", e);
    return res.status(500).json({ error: "server_error" });
  }
});

app.get("/me", auth, async (req, res) => {
  try {
    const idText = String(req.user?.id || "").trim();
    if (!idText) return res.status(401).json({ error: "no_token" });

    const me = await findUserByIdText(idText);
    if (!me) return res.status(404).json({ error: "user_not_found" });

    // ترجع id كنص دائمًا (يحمي من uuid/int)
    return res.json({
      id: me.id,
      email: me.email,
      full_name: me.full_name,
      role: me.role,
    });
  } catch (e) {
    console.error("GET /me:", e);
    return res.status(500).json({ error: "server_error" });
  }
});

/* =====================================================
   Auth Register (staff pending by default)
   - يبقى على public.users مثل ما عندك
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
    const activeCol = await getActiveColPublic();

    const q = await pool.query(
      `
      INSERT INTO public.users (full_name, email, password_hash, role, ${activeCol}, created_at)
      VALUES ($1, $2, $3, 'staff', false, NOW())
      RETURNING id::text AS id, full_name, email, role, ${activeCol} AS is_active
      `,
      [full_name, email, password_hash]
    );

    return res.status(201).json({ ok: true, user: q.rows[0] });
  } catch (e) {
    console.error("POST /auth/register:", e);
    return res.status(500).json({ error: "server_error" });
  }
});

/* =====================================================
   Auth Pending (manager)
===================================================== */
app.get("/auth/pending", auth, async (req, res) => {
  try {
    if (!mustBeManager(req, res)) return;

    const activeCol = await getActiveColPublic();

    const q = await pool.query(
      `
      SELECT id::text AS id, email, full_name, role, ${activeCol} AS is_active, created_at
      FROM public.users
      WHERE ${activeCol} = false
      ORDER BY created_at DESC NULLS LAST, id DESC
      `
    );
    return res.json(q.rows || []);
  } catch (e) {
    console.error("GET /auth/pending:", e);
    return res.status(500).json({ error: "server_error" });
  }
});

/* =====================================================
   Auth Approve (manager)
===================================================== */
app.post("/auth/approve", auth, async (req, res) => {
  try {
    if (!mustBeManager(req, res)) return;

    const userId = String(req.body?.userId || req.body?.id || req.body?.user_id || "").trim();
    if (!userId) return res.status(400).json({ error: "invalid_user_id" });

    const activeCol = await getActiveColPublic();

    const q = await pool.query(
      `
      UPDATE public.users
      SET ${activeCol}=true
      WHERE id::text=$1
      RETURNING id::text AS id, full_name, email, role, ${activeCol} AS is_active
      `,
      [userId]
    );
    if (!q.rowCount) return res.status(404).json({ error: "not_found" });
    return res.json({ ok: true, user: q.rows[0] });
  } catch (e) {
    console.error("POST /auth/approve:", e);
    return res.status(500).json({ error: "server_error" });
  }
});

/* =====================================================
   Auth Reject (manager)
===================================================== */
app.post("/auth/reject", auth, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!mustBeManager(req, res)) return;

    const userId = String((req.body && (req.body.userId ?? req.body.user_id)) || "").trim();
    if (!userId) return res.status(400).json({ error: "userId_required" });

    const activeCol = await getActiveColPublic();

    const r = await client.query(
      `UPDATE public.users SET ${activeCol}=false WHERE id::text=$1 AND role='staff' RETURNING id`,
      [userId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: "not_found" });

    return res.json({ ok: true });
  } catch (e) {
    console.error("POST /auth/reject:", e);
    return res.status(500).json({ error: "server_error" });
  } finally {
    client.release();
  }
});

/* =====================================================
   Employees (Manager)
===================================================== */
app.get("/employees", auth, async (req, res) => {
  try {
    if (!mustBeManager(req, res)) return;

    const activeCol = await getActiveColPublic();

    const q = await pool.query(`
      SELECT id::text AS id, full_name, email, role, ${activeCol} AS is_active
      FROM public.users
      WHERE role IN ('staff','manager')
      ORDER BY role DESC, id DESC
    `);

    return res.json(q.rows || []);
  } catch (e) {
    console.error("GET /employees:", e);
    return res.status(500).json({ error: "server_error" });
  }
});

app.patch("/employees/:id/active", auth, async (req, res) => {
  try {
    if (!mustBeManager(req, res)) return;

    const idText = String(req.params.id || "").trim();
    const active = !!req.body?.active;
    if (!idText) return res.status(400).json({ error: "invalid_id" });

    const activeCol = await getActiveColPublic();

    const q = await pool.query(
      `
      UPDATE public.users
      SET ${activeCol}=$1
      WHERE id::text=$2
      RETURNING id::text AS id, full_name, email, role, ${activeCol} AS is_active
      `,
      [active, idText]
    );
    if (!q.rowCount) return res.status(404).json({ error: "not_found" });
    return res.json({ ok: true, user: q.rows[0] });
  } catch (e) {
    console.error("PATCH /employees/:id/active:", e);
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
    const userIdText = String(user_id || "").trim();
    if (!caseId || !userIdText) return res.status(400).json({ error: "invalid_ids" });

    await client.query("BEGIN");

    const caseExists = await client.query(`SELECT 1 FROM cases WHERE id=$1`, [caseId]);
    if (caseExists.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "case_not_found" });
    }

    const activeCol = await getActiveColPublic();

    const uRow = await client.query(
      `SELECT role, ${activeCol} AS is_active FROM public.users WHERE id::text=$1`,
      [userIdText]
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

    // ✅ مسؤول واحد لكل قضية
    await client.query(`DELETE FROM assignments WHERE case_id=$1`, [caseId]);

    await client.query(
      `
      INSERT INTO assignments (case_id, user_id, note, assigned_by, assigned_at)
      VALUES ($1,$2,$3,$4,NOW())
      `,
      [caseId, Number(userIdText), note || null, Number(req.user.id)]
    );

    try {
      await client.query(
        `INSERT INTO activity_log (case_id, who, what) VALUES ($1,$2,$3)`,
        [caseId, String(req.user.id), `إسناد القضية للموظف #${userIdText}`]
      );
    } catch {}

    await client.query("COMMIT");
    return res.json({ ok: true });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    console.error("POST /assign:", e);
    return res.status(500).json({ error: "server_error" });
  } finally {
    client.release();
  }
});

/* =====================================================
   PUT OTHER ROUTES HERE (Cases / Sessions / Docs / Notes / ...)
   - الصقي راوتس مشروعك هنا إذا كانت موجودة في نسخة أكبر
===================================================== */

/* =====================================================
   SPA fallback (frontend)
===================================================== */
if (fs.existsSync(publicDir)) {
  app.get("/", (req, res) => res.sendFile(path.join(publicDir, "index.html")));

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
