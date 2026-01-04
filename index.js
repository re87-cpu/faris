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

// ✅ CORS (يدعم localhost + الدومينات)
const ORIGINS = (
  process.env.CORS_ORIGINS ||
  [
    "http://localhost:5173",
    "http://localhost:3000",
    "http://localhost:3003",
    "https://www.faris-legal.com",
    "https://faris-legal.com",
    "https://faris-legal.onrender.com",
    "https://faris-1-359l.onrender.com",
  ].join(",")
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (ORIGINS.includes(origin)) return cb(null, true);
      // ✅ مفتوح — لو تبين تقفلينه: cb(new Error("Not allowed by CORS"))
      return cb(null, true);
    },
    credentials: true,
  })
);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// __dirname for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* =====================================================
   Static uploads
===================================================== */
// ✅ استخدمي مجلد ثابت داخل مشروع الـ API نفسه (أفضل من process.cwd)
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// ✅ Serve uploaded files (مرة واحدة فقط)
app.use("/uploads", express.static(uploadsDir));

/* =====================================================
   Serve built frontend (single-domain)
===================================================== */
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

// تفضيل public (بدون ما يكسر لو عندك schema ثاني)
pool.on("connect", (client) => {
  client.query("SET search_path TO public").catch(() => {});
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
   Active Column Resolver (users.active vs users.is_active)
===================================================== */
let __usersActiveColCache = null;

async function getUsersActiveCol() {
  if (__usersActiveColCache) return __usersActiveColCache;
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
    if (cols.includes("is_active")) __usersActiveColCache = "is_active";
    else if (cols.includes("active")) __usersActiveColCache = "active";
    else __usersActiveColCache = null;
  } catch {
    __usersActiveColCache = null;
  }
  return __usersActiveColCache;
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

  try {
    const q = await pool.query(
      `SELECT 1 FROM assignments WHERE case_id=$1 AND user_id=$2 LIMIT 1`,
      [Number(caseId), Number(user.id)]
    );
    return q.rowCount > 0;
  } catch (e) {
    // لو جدول assignments مو موجود لأي سبب
    if (isMissingTable(e)) return false;
    return false;
  }
}

/* =====================================================
   Health ✅
===================================================== */
app.get("/health", async (_, res) => {
  try {
    const q = await pool.query(
      `SELECT current_database() AS db, inet_server_addr() AS addr, inet_server_port() AS port, current_user AS usr, current_setting('search_path') AS sp`
    );
    return res.json({
      ok: true,
      pid: process.pid,
      file: __filename,
      db: q.rows[0],
    });
  } catch (e) {
    return res.json({ ok: true, pid: process.pid, file: __filename, db_error: e.message });
  }
});

/* =====================================================
   Debug routes list (اختياري)
===================================================== */
app.get("/__routes", (req, res) => {
  const routes = [];
  app._router?.stack?.forEach((m) => {
    if (m.route?.path) {
      const methods = Object.keys(m.route.methods || {}).join(",").toUpperCase();
      routes.push(`${methods} ${m.route.path}`);
    }
  });
  res.json({ count: routes.length, routes });
});

/* =====================================================
   Auth
===================================================== */
app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "missing_credentials" });

    const activeCol = await getUsersActiveCol();

    const sql = `
      SELECT id, password_hash, role${activeCol ? `, ${activeCol} AS active` : ", true AS active"}
      FROM users
      WHERE lower(email) = lower($1)
      LIMIT 1
    `;
    const q = await pool.query(sql, [String(email).trim()]);
    if (!q.rowCount) return res.status(400).json({ error: "invalid_credentials" });
    if (!q.rows[0].active) return res.status(403).json({ error: "inactive" });

    const ok = await bcrypt.compare(String(password), String(q.rows[0].password_hash || ""));
    if (!ok) return res.status(400).json({ error: "invalid_credentials" });

    const token = jwt.sign(
      { id: q.rows[0].id, role: String(q.rows[0].role || "").trim().toLowerCase() },
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
    const q = await pool.query(`SELECT id, email, full_name, role FROM users WHERE id=$1`, [
      Number(req.user.id),
    ]);
    if (!q.rowCount) return res.status(404).json({ error: "user_not_found" });
    return res.json(q.rows[0]);
  } catch (e) {
    console.error("GET /me:", e);
    return res.status(500).json({ error: "server_error" });
  }
});

app.post("/auth/register", async (req, res) => {
  try {
    const full_name = String(req.body?.full_name || req.body?.name || "").trim();
    const email = String(req.body?.email || "").trim();
    const password = String(req.body?.password || "").trim();

    if (!full_name) return res.status(400).json({ error: "full_name_required" });
    if (!email) return res.status(400).json({ error: "email_required" });
    if (!password) return res.status(400).json({ error: "password_required" });

    const exists = await pool.query(`SELECT 1 FROM users WHERE lower(email)=lower($1) LIMIT 1`, [
      email,
    ]);
    if (exists.rowCount) return res.status(409).json({ error: "email_exists" });

    const password_hash = await bcrypt.hash(password, 10);
    const activeCol = await getUsersActiveCol();

    const q = await pool.query(
      `
      INSERT INTO users (full_name, email, password_hash, role${activeCol ? `, ${activeCol}` : ""}, created_at)
      VALUES ($1, $2, $3, 'staff'${activeCol ? ", false" : ""}, NOW())
      RETURNING id, full_name, email, role
      `,
      [full_name, email, password_hash]
    );

    return res.status(201).json({ ok: true, user: q.rows[0] });
  } catch (e) {
    console.error("POST /auth/register:", e);
    return res.status(500).json({ error: "server_error" });
  }
});

app.get("/auth/pending", auth, async (req, res) => {
  try {
    if (!mustBeManager(req, res)) return;
    const activeCol = await getUsersActiveCol();

    const q = await pool.query(
      `
      SELECT id, email, full_name, role, ${activeCol ? `${activeCol} AS active` : "false AS active"}, created_at
      FROM users
      WHERE ${activeCol ? `${activeCol}=false` : "false"}
      ORDER BY created_at DESC NULLS LAST, id DESC
      `
    );
    return res.json(q.rows || []);
  } catch (e) {
    console.error("GET /auth/pending:", e);
    return res.status(500).json({ error: "server_error" });
  }
});

app.post("/auth/approve", auth, async (req, res) => {
  try {
    if (!mustBeManager(req, res)) return;

    const userId = Number(req.body?.userId || req.body?.id || req.body?.user_id);
    if (!userId) return res.status(400).json({ error: "invalid_user_id" });

    const activeCol = await getUsersActiveCol();
    if (!activeCol) return res.status(400).json({ error: "active_column_missing" });

    const q = await pool.query(
      `
      UPDATE users SET ${activeCol}=true
      WHERE id=$1
      RETURNING id, full_name, email, role, ${activeCol} AS active
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

app.post("/auth/reject", auth, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!mustBeManager(req, res)) return;

    const userId = Number((req.body && (req.body.userId ?? req.body.user_id ?? req.body.id)) || 0);
    if (!userId) return res.status(400).json({ error: "userId_required" });

    const activeCol = await getUsersActiveCol();
    if (!activeCol) return res.status(400).json({ error: "active_column_missing" });

    const r = await client.query(
      `UPDATE users SET ${activeCol}=false WHERE id=$1 AND role='staff' RETURNING id`,
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

    const activeCol = await getUsersActiveCol();

    const q = await pool.query(`
      SELECT id, full_name, email, role,
             ${activeCol ? `${activeCol} AS active` : "true AS active"}
      FROM users
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

    const id = Number(req.params.id);
    const active = !!req.body?.active;
    if (!id) return res.status(400).json({ error: "invalid_id" });

    const activeCol = await getUsersActiveCol();
    if (!activeCol) return res.status(400).json({ error: "active_column_missing" });

    const q = await pool.query(
      `UPDATE users SET ${activeCol}=$1 WHERE id=$2 RETURNING id, full_name, email, role, ${activeCol} AS active`,
      [active, id]
    );
    if (!q.rowCount) return res.status(404).json({ error: "not_found" });
    return res.json({ ok: true, user: q.rows[0] });
  } catch (e) {
    console.error("PATCH /employees/:id/active:", e);
    return res.status(500).json({ error: "server_error" });
  }
});

/* =====================================================
   Cases
===================================================== */
app.get("/cases", auth, async (req, res) => {
  try {
    if (roleOf(req.user) === "manager") {
      const q = await pool.query(
        `
        SELECT
          c.id,
          c.case_number,
          c.title,
          c.status,
          c.court,
          c.next,
          c.created_at,
          c.updated_at,
          a.user_id AS assigned_to
        FROM cases c
        LEFT JOIN LATERAL (
          SELECT user_id
          FROM assignments
          WHERE case_id = c.id
          ORDER BY assigned_at DESC NULLS LAST, id DESC
          LIMIT 1
        ) a ON true
        ORDER BY c.created_at DESC NULLS LAST, c.id DESC
        `
      );
      return res.json(q.rows || []);
    }

    const q = await pool.query(
      `
      SELECT
        c.id,
        c.case_number,
        c.title,
        c.status,
        c.court,
        c.next,
        a.note AS "assignNote",
        a.assigned_at AS "assignedAt"
      FROM assignments a
      JOIN cases c ON c.id = a.case_id
      WHERE a.user_id = $1
      ORDER BY a.assigned_at DESC NULLS LAST, a.id DESC
      `,
      [Number(req.user.id)]
    );
    return res.json(q.rows || []);
  } catch (e) {
    console.error("GET /cases:", e);
    return res.status(500).json({ error: "server_error" });
  }
});

app.get("/cases/:id", auth, async (req, res) => {
  try {
    const raw = String(req.params.id || "").trim();
    if (!raw) return res.status(400).json({ error: "missing_id" });

    const q0 = await pool.query(`SELECT id FROM cases WHERE id::text=$1 OR case_number=$1 LIMIT 1`, [
      raw,
    ]);
    if (!q0.rowCount) return res.status(404).json({ error: "case_not_found" });

    const caseId = Number(q0.rows[0].id);

    const ok = await canAccessCase(caseId, req.user);
    if (!ok) return res.status(403).json({ error: "forbidden" });

    const q = await pool.query(
      `
      SELECT c.*, a.user_id AS assigned_to
      FROM cases c
      LEFT JOIN LATERAL (
        SELECT user_id
        FROM assignments
        WHERE case_id = c.id
        ORDER BY assigned_at DESC NULLS LAST, id DESC
        LIMIT 1
      ) a ON true
      WHERE c.id = $1
      LIMIT 1
      `,
      [caseId]
    );

    if (!q.rowCount) return res.status(404).json({ error: "case_not_found" });
    return res.json(q.rows[0]);
  } catch (e) {
    console.error("GET /cases/:id:", e);
    return res.status(500).json({ error: "server_error" });
  }
});

app.post("/cases", auth, async (req, res) => {
  try {
    if (!mustBeManager(req, res)) return;

    const { case_number, title, status, court, next } = req.body || {};
    if (!case_number || !String(case_number).trim())
      return res.status(400).json({ error: "missing_case_number" });
    if (!title || !String(title).trim()) return res.status(400).json({ error: "missing_title" });

    const q = await pool.query(
      `
      INSERT INTO cases (case_number, title, status, court, next)
      VALUES ($1,$2,$3,$4,$5)
      RETURNING *
      `,
      [String(case_number).trim(), String(title).trim(), status || "open", court || null, next || null]
    );

    return res.status(201).json(q.rows[0]);
  } catch (e) {
    console.error("POST /cases:", e);
    return res.status(500).json({ error: "server_error" });
  }
});

app.patch("/cases/:id", auth, async (req, res) => {
  try {
    if (!mustBeManager(req, res)) return;

    const raw = String(req.params.id || "").trim();
    if (!raw) return res.status(400).json({ error: "missing_id" });

    const title = req.body?.title;
    const status = req.body?.status;
    const court = req.body?.court;
    const next = req.body?.next;

    const q0 = await pool.query(`SELECT id FROM cases WHERE id::text=$1 OR case_number=$1 LIMIT 1`, [
      raw,
    ]);
    if (!q0.rowCount) return res.status(404).json({ error: "case_not_found" });

    const caseId = Number(q0.rows[0].id);

    const fields = [];
    const vals = [];
    let i = 1;

    if (title !== undefined) {
      fields.push(`title=$${i++}`);
      vals.push(title);
    }
    if (status !== undefined) {
      fields.push(`status=$${i++}`);
      vals.push(status);
    }
    if (court !== undefined) {
      fields.push(`court=$${i++}`);
      vals.push(court);
    }
    if (next !== undefined) {
      fields.push(`next=$${i++}`);
      vals.push(next);
    }

    if (!fields.length) return res.status(400).json({ error: "nothing_to_update" });

    let sql = `
      UPDATE cases
      SET ${fields.join(", ")}, updated_at=NOW()
      WHERE id=$${i}
      RETURNING *
    `;

    try {
      const q = await pool.query(sql, [...vals, caseId]);
      return res.json(q.rows[0]);
    } catch (e) {
      if (!isMissingColumn(e)) throw e;
      sql = `
        UPDATE cases
        SET ${fields.join(", ")}
        WHERE id=$${i}
        RETURNING *
      `;
      const q2 = await pool.query(sql, [...vals, caseId]);
      return res.json(q2.rows[0]);
    }
  } catch (e) {
    console.error("PATCH /cases/:id:", e);
    return res.status(500).json({ error: "server_error" });
  }
});

app.post("/cases/:id/close", auth, async (req, res) => {
  try {
    if (!mustBeManager(req, res)) return;
    const raw = String(req.params.id || "").trim();
    if (!raw) return res.status(400).json({ error: "missing_id" });

    const q0 = await pool.query(`SELECT id FROM cases WHERE id::text=$1 OR case_number=$1 LIMIT 1`, [
      raw,
    ]);
    if (!q0.rowCount) return res.status(404).json({ error: "case_not_found" });

    const caseId = Number(q0.rows[0].id);

    try {
      const q = await pool.query(
        `UPDATE cases SET status='closed', updated_at=NOW() WHERE id=$1 RETURNING *`,
        [caseId]
      );
      return res.json({ ok: true, case: q.rows[0] });
    } catch (e) {
      if (!isMissingColumn(e)) throw e;
      const q2 = await pool.query(`UPDATE cases SET status='closed' WHERE id=$1 RETURNING *`, [
        caseId,
      ]);
      return res.json({ ok: true, case: q2.rows[0] });
    }
  } catch (e) {
    console.error("POST /cases/:id/close:", e);
    return res.status(500).json({ error: "server_error" });
  }
});

app.post("/cases/:id/reopen", auth, async (req, res) => {
  try {
    if (!mustBeManager(req, res)) return;
    const raw = String(req.params.id || "").trim();
    if (!raw) return res.status(400).json({ error: "missing_id" });

    const q0 = await pool.query(`SELECT id FROM cases WHERE id::text=$1 OR case_number=$1 LIMIT 1`, [
      raw,
    ]);
    if (!q0.rowCount) return res.status(404).json({ error: "case_not_found" });

    const caseId = Number(q0.rows[0].id);

    try {
      const q = await pool.query(
        `UPDATE cases SET status='open', updated_at=NOW() WHERE id=$1 RETURNING *`,
        [caseId]
      );
      return res.json({ ok: true, case: q.rows[0] });
    } catch (e) {
      if (!isMissingColumn(e)) throw e;
      const q2 = await pool.query(`UPDATE cases SET status='open' WHERE id=$1 RETURNING *`, [caseId]);
      return res.json({ ok: true, case: q2.rows[0] });
    }
  } catch (e) {
    console.error("POST /cases/:id/reopen:", e);
    return res.status(500).json({ error: "server_error" });
  }
});

app.delete("/cases/:id", auth, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!mustBeManager(req, res)) return;

    const raw = String(req.params.id || "").trim();
    if (!raw) return res.status(400).json({ error: "missing_id" });

    const q0 = await client.query(`SELECT id FROM cases WHERE id::text=$1 OR case_number=$1 LIMIT 1`, [
      raw,
    ]);
    if (!q0.rowCount) return res.status(404).json({ error: "case_not_found" });

    const caseId = Number(q0.rows[0].id);

    await client.query("BEGIN");

    for (const t of ["activity_log", "case_notes", "case_documents", "sessions", "assignments"]) {
      try {
        await client.query(`DELETE FROM ${t} WHERE case_id=$1`, [caseId]);
      } catch (e) {
        if (!isMissingTable(e)) throw e;
      }
    }

    await client.query(`DELETE FROM cases WHERE id=$1`, [caseId]);
    await client.query("COMMIT");
    return res.status(204).send();
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    console.error("DELETE /cases/:id:", e);
    return res.status(500).json({ error: "server_error" });
  } finally {
    client.release();
  }
});

/* =====================================================
   Assign (manager) ✅ مسؤول واحد لكل قضية
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

    const activeCol = await getUsersActiveCol();
    const uSql = `
      SELECT role${activeCol ? `, ${activeCol} AS active` : ", true AS active"}
      FROM users
      WHERE id=$1
      LIMIT 1
    `;
    const uRow = await client.query(uSql, [userId]);
    if (uRow.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "user_not_found" });
    }

    const role = String(uRow.rows[0].role || "").toLowerCase();
    if (role !== "staff") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "assignee_must_be_staff" });
    }
    if (!uRow.rows[0].active) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "assignee_not_active" });
    }

    await client.query(`DELETE FROM assignments WHERE case_id=$1`, [caseId]);
    await client.query(
      `
      INSERT INTO assignments (case_id, user_id, note, assigned_by, assigned_at)
      VALUES ($1,$2,$3,$4,NOW())
      `,
      [caseId, userId, note || null, Number(req.user.id)]
    );

    try {
      await client.query(`INSERT INTO activity_log (case_id, who, what) VALUES ($1,$2,$3)`, [
        caseId,
        String(req.user.id),
        `إسناد القضية للموظف #${userId}`,
      ]);
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
   My Cases (staff)
===================================================== */
app.get("/my/cases", auth, async (req, res) => {
  try {
    if (!mustBeStaff(req, res)) return;

    const q = await pool.query(
      `
      SELECT
        c.id,
        c.case_number,
        c.title,
        c.status,
        c.court,
        c.next,
        a.note        AS "assignNote",
        a.assigned_at AS "assignedAt"
      FROM assignments a
      JOIN cases c ON c.id = a.case_id
      WHERE a.user_id = $1
      ORDER BY a.assigned_at DESC NULLS LAST, a.id DESC
      `,
      [Number(req.user.id)]
    );

    return res.json(q.rows || []);
  } catch (e) {
    console.error("GET /my/cases:", e);
    return res.status(500).json({ error: "server_error" });
  }
});

/* =====================================================
   Activity
===================================================== */
app.get("/activity/recent", auth, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(100, Number(req.query?.limit) || 12));
    try {
      const q = await pool.query(
        `
        SELECT id, case_id AS "caseId", who, what, created_at AS "at"
        FROM activity_log
        ORDER BY created_at DESC NULLS LAST, id DESC
        LIMIT $1
        `,
        [limit]
      );
      return res.json(q.rows || []);
    } catch (e) {
      if (isMissingTable(e)) return res.json([]);
      return res.json([]);
    }
  } catch (e) {
    console.error("GET /activity/recent:", e);
    return res.json([]);
  }
});

/* =====================================================
   Sessions/week  ✅ (مُهيأ للواجهة)
===================================================== */
app.get("/sessions/week", auth, async (req, res) => {
  try {
    try {
      const q = await pool.query(
        `
        SELECT
          s.id,
          s.session_at,
          s.court,
          c.id AS case_id,
          c.case_number,
          c.title
        FROM sessions s
        JOIN cases c ON c.id = s.case_id
        WHERE s.session_at >= NOW() - INTERVAL '7 days'
        ORDER BY s.session_at DESC
        LIMIT 200
        `
      );

      const rows = Array.isArray(q.rows) ? q.rows : [];
      const out = rows.map((r) => {
        const dt = r.session_at ? new Date(r.session_at) : null;
        const date = dt ? dt.toLocaleDateString("ar-SA") : "";
        const time = dt ? dt.toLocaleTimeString("ar-SA", { hour: "2-digit", minute: "2-digit" }) : "";
        return {
          id: r.id,
          caseId: r.case_id,
          caseNo: r.case_number,
          title: r.title || "—",
          court: r.court || "—",
          date,
          time,
          sessionAt: r.session_at,
        };
      });

      return res.json(out);
    } catch (e) {
      if (isMissingTable(e)) return res.json([]);
      console.error("GET /sessions/week SQL:", e);
      return res.json([]);
    }
  } catch (e) {
    console.error("GET /sessions/week:", e);
    return res.json([]);
  }
});

/* =====================================================
   Sessions داخل القضية
===================================================== */
app.get("/cases/:id/sessions", auth, async (req, res) => {
  try {
    const caseId = Number(req.params.id);
    if (!caseId) return res.json([]);

    // ✅ لو القضية غير موجودة: رجع 404 (أفضل من لخبطة)
    const chk = await pool.query(`SELECT 1 FROM cases WHERE id=$1 LIMIT 1`, [caseId]);
    if (chk.rowCount === 0) return res.status(404).json({ error: "case_not_found" });

    const ok = await canAccessCase(caseId, req.user);
    if (!ok) return res.status(403).json({ error: "forbidden" });

    try {
      const q = await pool.query(
        `
        SELECT
          s.id,
          s.session_at AS "sessionAt",
          s.court,
          s.room,
          s.notes,
          s.summary,
          s.summary_by AS "summaryBy",
          s.summary_at AS "summaryAt"
        FROM sessions s
        WHERE s.case_id = $1
        ORDER BY s.session_at DESC
        `,
        [caseId]
      );
      return res.json(q.rows || []);
    } catch (e) {
      if (isMissingTable(e)) return res.json([]);
      throw e;
    }
  } catch (e) {
    console.error("GET /cases/:id/sessions:", e);
    return res.status(500).json({ error: "server_error" });
  }
});

app.post("/cases/:id/sessions", auth, async (req, res) => {
  try {
    const caseId = Number(req.params.id);
    if (!caseId) return res.status(400).json({ error: "invalid_case_id" });

    // ✅ FIX: قبل أي INSERT تأكدي إن القضية موجودة (يمنع FK 500)
    const chk = await pool.query(`SELECT 1 FROM cases WHERE id=$1 LIMIT 1`, [caseId]);
    if (chk.rowCount === 0) return res.status(404).json({ error: "case_not_found" });

    if (roleOf(req.user) !== "manager") {
      const ok = await canAccessCase(caseId, req.user);
      if (!ok) return res.status(403).json({ error: "forbidden" });
    }

    const session_at = String(req.body?.session_at || "").trim();
    if (!session_at) return res.status(400).json({ error: "session_at_required" });

    const court = req.body?.court || null;
    const room = req.body?.room || null;
    const notes = req.body?.notes || null;

    try {
      const q = await pool.query(
        `
        INSERT INTO sessions (case_id, session_at, court, room, notes)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
        `,
        [caseId, session_at, court, room, notes]
      );

      try {
        await pool.query(`INSERT INTO activity_log (case_id, who, what) VALUES ($1,$2,$3)`, [
          caseId,
          String(req.user.id),
          `إضافة جلسة جديدة`,
        ]);
      } catch {}

      return res.status(201).json(q.rows[0]);
    } catch (e) {
      if (isMissingTable(e)) return res.status(400).json({ error: "sessions_table_missing" });
      console.error("POST /cases/:id/sessions SQL:", e);
      throw e;
    }
  } catch (e) {
    console.error("POST /cases/:id/sessions:", e);
    return res.status(500).json({ error: "server_error" });
  }
});

app.post("/cases/:cid/sessions/:sid/summary", auth, async (req, res) => {
  try {
    const caseId = Number(req.params.cid);
    const sessionId = Number(req.params.sid);
    const summary = String(req.body?.summary || "").trim();

    if (!caseId || !sessionId) return res.status(400).json({ error: "invalid_ids" });
    if (!summary) return res.status(400).json({ error: "summary_required" });

    const ok = await canAccessCase(caseId, req.user);
    if (!ok) return res.status(403).json({ error: "forbidden" });

    try {
      const q = await pool.query(
        `
        UPDATE sessions
        SET summary=$1, summary_by=$2, summary_at=NOW()
        WHERE id=$3 AND case_id=$4
        RETURNING *
        `,
        [summary, Number(req.user.id), sessionId, caseId]
      );
      if (!q.rowCount) return res.status(404).json({ error: "not_found" });

      try {
        await pool.query(`INSERT INTO activity_log (case_id, who, what) VALUES ($1,$2,$3)`, [
          caseId,
          String(req.user.id),
          `إضافة/تعديل ملخص الجلسة #${sessionId}`,
        ]);
      } catch {}

      return res.json(q.rows[0]);
    } catch (e) {
      if (isMissingTable(e)) return res.status(400).json({ error: "sessions_table_missing" });
      throw e;
    }
  } catch (e) {
    console.error("POST /cases/:cid/sessions/:sid/summary:", e);
    return res.status(500).json({ error: "server_error" });
  }
});

/* =====================================================
   Documents (case_documents)
===================================================== */
function toFileUrl(fileNameOrUrl) {
  const raw = (fileNameOrUrl || "").toString().trim();
  if (!raw) return null;
  const isHttp = raw.startsWith("http://") || raw.startsWith("https://");
  return isHttp ? raw : `/uploads/${raw}`;
}

app.get("/cases/:id/docs", auth, async (req, res) => {
  try {
    const caseId = Number(req.params.id);
    if (!caseId) return res.json([]);

    const ok = await canAccessCase(caseId, req.user);
    if (!ok) return res.status(403).json({ error: "forbidden" });

    const q = await pool.query(
      `
      SELECT
        id,
        case_id AS "caseId",
        COALESCE(NULLIF(name,''), NULLIF(title,''), NULLIF(file_name,''), 'مستند') AS "name",
        title AS "title",
        file_name AS "fileName",
        uploaded_by AS "uploadedBy",
        uploaded_at AS "uploadedAt"
      FROM case_documents
      WHERE case_id=$1
      ORDER BY uploaded_at DESC NULLS LAST, id DESC
      `,
      [caseId]
    );

    const rows = Array.isArray(q.rows) ? q.rows : [];
    const out = rows.map((r) => ({
      id: r.id,
      caseId: r.caseId,
      name: r.name || "مستند",
      uploadedBy: r.uploadedBy || null,
      uploadedAt: r.uploadedAt || null,
      fileName: r.fileName || null,
      fileUrl: toFileUrl(r.fileName),
    }));

    return res.json(out);
  } catch (e) {
    if (isMissingTable(e)) return res.json([]);
    if (isMissingColumn(e)) return res.json([]);
    console.error("GET /cases/:id/docs:", e);
    return res.json([]);
  }
});

app.post("/cases/:id/docs", auth, async (req, res) => {
  try {
    const caseId = Number(req.params.id);
    if (!caseId) return res.status(400).json({ error: "invalid_case_id" });

    const ok = await canAccessCase(caseId, req.user);
    if (!ok) return res.status(403).json({ error: "forbidden" });

    const name = String(req.body?.name || req.body?.title || "").trim();
    if (!name) return res.status(400).json({ error: "name_required" });

    const fileUrl = String(req.body?.fileUrl || req.body?.file_url || "").trim();
    const fileNameOrUrl = fileUrl || null;

    const uid = String(req.user.id);

    const q = await pool.query(
      `
      INSERT INTO case_documents
        (case_id, name, title, file_name, uploaded_by, uploaded_at)
      VALUES
        ($1,$2,$3,$4,$5::text,NOW())
      RETURNING
        id,
        case_id AS "caseId",
        name AS "name",
        title AS "title",
        file_name AS "fileName",
        uploaded_by AS "uploadedBy",
        uploaded_at AS "uploadedAt"
      `,
      [caseId, name, name, fileNameOrUrl, uid]
    );

    const row = q.rows[0];
    return res.status(201).json({
      id: row.id,
      caseId: row.caseId,
      name: row.name || name,
      uploadedBy: row.uploadedBy || uid,
      uploadedAt: row.uploadedAt || null,
      fileName: row.fileName || null,
      fileUrl: toFileUrl(row.fileName),
    });
  } catch (e) {
    if (isMissingTable(e)) return res.status(400).json({ error: "docs_table_missing" });
    console.error("POST /cases/:id/docs:", e);
    return res.status(500).json({ error: "server_error" });
  }
});

app.post("/cases/:id/docs/upload", auth, upload.single("file"), async (req, res) => {
  try {
    const caseId = Number(req.params.id);
    if (!caseId) return res.status(400).json({ error: "invalid_case_id" });

    const ok = await canAccessCase(caseId, req.user);
    if (!ok) return res.status(403).json({ error: "forbidden" });

    if (!req.file) return res.status(400).json({ error: "file_required" });

    const storedFileName = req.file.filename;
    const originalName = req.file.originalname || "";
    const name = String(req.body?.name || originalName || "مستند").trim();

    const uid = String(req.user.id);

    const q = await pool.query(
      `
      INSERT INTO case_documents
        (case_id, name, title, file_name, uploaded_by, uploaded_at)
      VALUES
        ($1,$2,$3,$4,$5::text,NOW())
      RETURNING
        id,
        case_id AS "caseId",
        name AS "name",
        title AS "title",
        file_name AS "fileName",
        uploaded_by AS "uploadedBy",
        uploaded_at AS "uploadedAt"
      `,
      [caseId, name, name, storedFileName, uid]
    );

    const row = q.rows[0];
    return res.status(201).json({
      id: row.id,
      caseId: row.caseId,
      name: row.name || name,
      uploadedBy: row.uploadedBy || uid,
      uploadedAt: row.uploadedAt || null,
      fileName: row.fileName || storedFileName,
      fileUrl: toFileUrl(row.fileName || storedFileName),
    });
  } catch (e) {
    console.error("UPLOAD DOC:", e);
    return res.status(500).json({ error: "server_error" });
  }
});

/* =====================================================
   Notes / Timeline / Notifications / Tasks / Drafts
   (باقي ملفك كما هو)
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
      req.path.startsWith("/health") ||
      req.path.startsWith("/__routes")
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
