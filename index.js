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
app.use(cors({ origin: true, credentials: true }));
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
   🔥 Active Column Resolver (NO MORE "active does not exist")
===================================================== */
let __activeColCache = null;

/**
 * Returns which column exists in users table: "is_active" or "active"
 * Defaults to "is_active" safely.
 */
async function getActiveCol() {
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
    else __activeColCache = "is_active"; // safe default
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
      `SELECT current_database() AS db, inet_server_addr() AS addr, inet_server_port() AS port, current_user AS usr`
    );
    const activeCol = await getActiveCol();
    return res.json({
      ok: true,
      pid: process.pid,
      file: __filename,
      activeCol,
      db: q.rows[0],
    });
  } catch (e) {
    const activeCol = await getActiveCol().catch(() => "unknown");
    return res.json({
      ok: true,
      pid: process.pid,
      file: __filename,
      activeCol,
      db_error: e.message,
    });
  }
});

/* =====================================================
   Auth
===================================================== */
app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "missing_credentials" });
    }

    const activeCol = await getActiveCol();

    const q = await pool.query(
      `
      SELECT
        id,
        password_hash,
        role,
        ${activeCol} AS is_active
      FROM users
      WHERE lower(email) = lower($1)
      LIMIT 1
      `,
      [email]
    );

    if (!q.rowCount) {
      return res.status(400).json({ error: "invalid_credentials" });
    }

    const user = q.rows[0];
    const isActive = (user.is_active ?? true) === true;
    if (!isActive) {
      return res.status(403).json({ error: "inactive" });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(400).json({ error: "invalid_credentials" });
    }

    const token = jwt.sign(
      {
        id: user.id,
        role: String(user.role || "").trim().toLowerCase(),
      },
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
    const q = await pool.query(
      "SELECT id, email, full_name, role FROM users WHERE id=$1",
      [Number(req.user.id)]
    );
    if (!q.rowCount) {
      return res.status(404).json({ error: "user_not_found" });
    }
    return res.json(q.rows[0]);
  } catch (e) {
    console.error("GET /me:", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});/* =====================================================
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

    const activeCol = await getActiveCol();

    const q = await pool.query(
      `
      SELECT
        id,
        password_hash,
        role,
        ${activeCol} AS is_active
      FROM public.users
      WHERE lower(email) = lower($1)
      LIMIT 1
      `,
      [emailNorm]
    );

    if (!q.rowCount) {
      return res.status(400).json({ error: "invalid_credentials" });
    }

    const user = q.rows[0];
    const isActive = (user.is_active ?? true) === true;
    if (!isActive) {
      return res.status(403).json({ error: "inactive" });
    }

    const ok = await bcrypt.compare(passNorm, user.password_hash);
    if (!ok) {
      return res.status(400).json({ error: "invalid_credentials" });
    }

    const token = jwt.sign(
      {
        id: user.id,
        role: String(user.role || "").trim().toLowerCase(),
      },
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
    const q = await pool.query(
      "SELECT id, email, full_name, role FROM public.users WHERE id=$1",
      [Number(req.user.id)]
    );
    if (!q.rowCount) {
      return res.status(404).json({ error: "user_not_found" });
    }
    return res.json(q.rows[0]);
  } catch (e) {
    console.error("GET /me:", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

/* =====================================================
   Auth Register (staff pending by default)
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

    const activeCol = await getActiveCol();

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
   Auth Pending (manager)
===================================================== */
app.get("/auth/pending", auth, async (req, res) => {
  try {
    if (!mustBeManager(req, res)) return;

    const activeCol = await getActiveCol();

    const q = await pool.query(
      `
      SELECT id, email, full_name, role, ${activeCol} AS is_active, created_at
      FROM public.users
      WHERE ${activeCol} = false
      ORDER BY created_at DESC NULLS LAST, id DESC
      `
    );
    return res.json(q.rows || []);
  } catch (e) {
    console.error("GET /auth/pending:", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

/* =====================================================
   Auth Approve (manager)
===================================================== */
app.post("/auth/approve", auth, async (req, res) => {
  try {
    if (!mustBeManager(req, res)) return;

    const userId = Number(req.body?.userId || req.body?.id || req.body?.user_id);
    if (!userId) return res.status(400).json({ error: "invalid_user_id" });

    const activeCol = await getActiveCol();

    const q = await pool.query(
      `
      UPDATE public.users
      SET ${activeCol}=true
      WHERE id=$1
      RETURNING id, full_name, email, role, ${activeCol} AS is_active
      `,
      [userId]
    );
    if (!q.rowCount) return res.status(404).json({ error: "not_found" });
    return res.json({ ok: true, user: q.rows[0] });
  } catch (e) {
    console.error("POST /auth/approve:", e.message);
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

    const userId = Number((req.body && (req.body.userId ?? req.body.user_id)) || 0);
    if (!userId) return res.status(400).json({ error: "userId_required" });

    const activeCol = await getActiveCol();

    const r = await client.query(
      `UPDATE public.users SET ${activeCol}=false WHERE id=$1 AND role='staff' RETURNING id`,
      [userId]
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
   Employees (Manager)
===================================================== */
app.get("/employees", auth, async (req, res) => {
  try {
    if (!mustBeManager(req, res)) return;

    const activeCol = await getActiveCol();

    const q = await pool.query(`
      SELECT id, full_name, email, role, ${activeCol} AS is_active
      FROM users
      WHERE role IN ('staff','manager')
      ORDER BY role DESC, id DESC
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

    const id = Number(req.params.id);
    const active = !!req.body?.active;
    if (!id) return res.status(400).json({ error: "invalid_id" });

    const activeCol = await getActiveCol();

    const q = await pool.query(
      `UPDATE users SET ${activeCol}=$1 WHERE id=$2 RETURNING id, full_name, email, role, ${activeCol} AS is_active`,
      [active, id]
    );
    if (!q.rowCount) return res.status(404).json({ error: "not_found" });
    return res.json({ ok: true, user: q.rows[0] });
  } catch (e) {
    console.error("PATCH /employees/:id/active error:", e.message);
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
    console.error("GET /cases error:", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

app.get("/cases/:id", auth, async (req, res) => {
  try {
    const raw = String(req.params.id || "").trim();
    if (!raw) return res.status(400).json({ error: "missing_id" });

    const q0 = await pool.query(
      `SELECT id FROM cases WHERE id::text=$1 OR case_number=$1 LIMIT 1`,
      [raw]
    );
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
    console.error("GET /cases/:id error:", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

app.post("/cases", auth, async (req, res) => {
  try {
    if (!mustBeManager(req, res)) return;

    const { case_number, title, status, court, next } = req.body || {};
    if (!case_number || !String(case_number).trim()) {
      return res.status(400).json({ error: "missing_case_number" });
    }
    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: "missing_title" });
    }

    const q = await pool.query(
      `
      INSERT INTO cases (case_number, title, status, court, next)
      VALUES ($1,$2,$3,$4,$5)
      RETURNING *
      `,
      [
        String(case_number).trim(),
        String(title).trim(),
        status || "open",
        court || null,
        next || null,
      ]
    );

    return res.status(201).json(q.rows[0]);
  } catch (e) {
    console.error("POST /cases error:", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

/* =====================================================
   Case Meta PATCH (manager)
===================================================== */
app.patch("/cases/:id", auth, async (req, res) => {
  try {
    if (!mustBeManager(req, res)) return;

    const raw = String(req.params.id || "").trim();
    if (!raw) return res.status(400).json({ error: "missing_id" });

    const title = req.body?.title;
    const status = req.body?.status;
    const court = req.body?.court;
    const next = req.body?.next;

    const q0 = await pool.query(
      `SELECT id FROM cases WHERE id::text=$1 OR case_number=$1 LIMIT 1`,
      [raw]
    );
    if (!q0.rowCount) return res.status(404).json({ error: "case_not_found" });

    const caseId = Number(q0.rows[0].id);

    const fields = [];
    const vals = [];
    let i = 1;

    if (title !== undefined) { fields.push(`title=$${i++}`); vals.push(title); }
    if (status !== undefined) { fields.push(`status=$${i++}`); vals.push(status); }
    if (court !== undefined) { fields.push(`court=$${i++}`); vals.push(court); }
    if (next !== undefined) { fields.push(`next=$${i++}`); vals.push(next); }

    if (!fields.length) return res.status(400).json({ error: "nothing_to_update" });

    // updated_at قد لا يكون موجود عند بعض المخططات، لذلك نحاول ثم نسقطه
    try {
      const q = await pool.query(
        `
        UPDATE cases
        SET ${fields.join(", ")}, updated_at=NOW()
        WHERE id=$${i}
        RETURNING *
        `,
        [...vals, caseId]
      );
      return res.json(q.rows[0]);
    } catch (e) {
      if (!isMissingColumn(e)) throw e;
      const q2 = await pool.query(
        `
        UPDATE cases
        SET ${fields.join(", ")}
        WHERE id=$${i}
        RETURNING *
        `,
        [...vals, caseId]
      );
      return res.json(q2.rows[0]);
    }
  } catch (e) {
    console.error("PATCH /cases/:id error:", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

/* =====================================================
   Close / Reopen (manager)
===================================================== */
app.post("/cases/:id/close", auth, async (req, res) => {
  try {
    if (!mustBeManager(req, res)) return;

    const raw = String(req.params.id || "").trim();
    if (!raw) return res.status(400).json({ error: "missing_id" });

    const q0 = await pool.query(
      `SELECT id FROM cases WHERE id::text=$1 OR case_number=$1 LIMIT 1`,
      [raw]
    );
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
      const q2 = await pool.query(
        `UPDATE cases SET status='closed' WHERE id=$1 RETURNING *`,
        [caseId]
      );
      return res.json({ ok: true, case: q2.rows[0] });
    }
  } catch (e) {
    console.error("POST /cases/:id/close error:", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

app.post("/cases/:id/reopen", auth, async (req, res) => {
  try {
    if (!mustBeManager(req, res)) return;

    const raw = String(req.params.id || "").trim();
    if (!raw) return res.status(400).json({ error: "missing_id" });

    const q0 = await pool.query(
      `SELECT id FROM cases WHERE id::text=$1 OR case_number=$1 LIMIT 1`,
      [raw]
    );
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
      const q2 = await pool.query(
        `UPDATE cases SET status='open' WHERE id=$1 RETURNING *`,
        [caseId]
      );
      return res.json({ ok: true, case: q2.rows[0] });
    }
  } catch (e) {
    console.error("POST /cases/:id/reopen error:", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

/* =====================================================
   DELETE Case (manager)
===================================================== */
app.delete("/cases/:id", auth, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!mustBeManager(req, res)) return;

    const raw = String(req.params.id || "").trim();
    if (!raw) return res.status(400).json({ error: "missing_id" });

    const q0 = await client.query(
      `SELECT id FROM cases WHERE id::text=$1 OR case_number=$1 LIMIT 1`,
      [raw]
    );
    if (!q0.rowCount) return res.status(404).json({ error: "case_not_found" });

    const caseId = Number(q0.rows[0].id);

    await client.query("BEGIN");

    try { await client.query(`DELETE FROM activity_log WHERE case_id=$1`, [caseId]); } catch (e) { if (!isMissingTable(e)) throw e; }
    try { await client.query(`DELETE FROM case_notes WHERE case_id=$1`, [caseId]); } catch (e) { if (!isMissingTable(e)) throw e; }
    try { await client.query(`DELETE FROM case_documents WHERE case_id=$1`, [caseId]); } catch (e) { if (!isMissingTable(e)) throw e; }
    try { await client.query(`DELETE FROM sessions WHERE case_id=$1`, [caseId]); } catch (e) { if (!isMissingTable(e)) throw e; }
    try { await client.query(`DELETE FROM assignments WHERE case_id=$1`, [caseId]); } catch (e) { if (!isMissingTable(e)) throw e; }

    await client.query(`DELETE FROM cases WHERE id=$1`, [caseId]);

    await client.query("COMMIT");
    return res.status(204).send();
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("DELETE /cases/:id error:", e.message);
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

    console.log("📌 /assign HIT", {
      user: req.user,
      body: req.body,
      ct: req.headers["content-type"],
    });

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

    const activeCol = await getActiveCol();

    const uRow = await client.query(`SELECT role, ${activeCol} AS is_active FROM users WHERE id=$1`, [userId]);
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

    // ✅ مسؤول واحد لكل قضية (هذا لا يمنع الموظف يكون عنده قضايا كثيرة)
    await client.query(`DELETE FROM assignments WHERE case_id=$1`, [caseId]);

    await client.query(
      `
      INSERT INTO assignments (case_id, user_id, note, assigned_by, assigned_at)
      VALUES ($1,$2,$3,$4,NOW())
      `,
      [caseId, userId, note || null, Number(req.user.id)]
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
    console.error("GET /my/cases error:", e.message);
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
    console.error("GET /activity/recent error:", e.message);
    return res.json([]);
  }
});

/* =====================================================
   Sessions/week
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
      return res.json(q.rows || []);
    } catch (e) {
      if (isMissingTable(e)) return res.json([]);
      return res.json([]);
    }
  } catch (e) {
    console.error("GET /sessions/week error:", e.message);
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
    console.error("GET /cases/:id/sessions error:", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

app.post("/cases/:id/sessions", auth, async (req, res) => {
  try {
    const caseId = Number(req.params.id);
    if (!caseId) return res.status(400).json({ error: "invalid_case_id" });

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
        await pool.query(
          `INSERT INTO activity_log (case_id, who, what) VALUES ($1,$2,$3)`,
          [caseId, String(req.user.id), `إضافة جلسة جديدة`]
        );
      } catch {}

      return res.status(201).json(q.rows[0]);
    } catch (e) {
      if (isMissingTable(e)) return res.status(400).json({ error: "sessions_table_missing" });
      throw e;
    }
  } catch (e) {
    console.error("POST /cases/:id/sessions error:", e.message);
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
        await pool.query(
          `INSERT INTO activity_log (case_id, who, what) VALUES ($1,$2,$3)`,
          [caseId, String(req.user.id), `إضافة/تعديل ملخص الجلسة #${sessionId}`]
        );
      } catch {}

      return res.json(q.rows[0]);
    } catch (e) {
      if (isMissingTable(e)) return res.status(400).json({ error: "sessions_table_missing" });
      throw e;
    }
  } catch (e) {
    console.error("POST /cases/:cid/sessions/:sid/summary error:", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

/* =====================================================
   Documents
===================================================== */
app.get("/cases/:id/docs", auth, async (req, res) => {
  const caseId = Number(req.params.id);
  if (!caseId) return res.json([]);

  const ok = await canAccessCase(caseId, req.user);
  if (!ok) return res.status(403).json({ error: "forbidden" });

  const tries = [
    `
    SELECT
      id,
      case_id AS "caseId",
      name AS "name",
      file_url AS "fileUrl",
      uploaded_by AS "uploadedBy",
      uploaded_at AS "uploadedAt"
    FROM case_documents
    WHERE case_id=$1
    ORDER BY uploaded_at DESC NULLS LAST, id DESC
    `,
    `
    SELECT
      id,
      case_id AS "caseId",
      COALESCE(title, file_name) AS "name",
      file_url AS "fileUrl",
      uploaded_by AS "uploadedBy",
      uploaded_at AS "uploadedAt"
    FROM case_documents
    WHERE case_id=$1
    ORDER BY uploaded_at DESC NULLS LAST, id DESC
    `,
    `
    SELECT
      id,
      case_id AS "caseId",
      name AS "name",
      NULL::text AS "fileUrl",
      NULL::text AS "uploadedBy",
      NULL::timestamptz AS "uploadedAt"
    FROM case_documents
    WHERE case_id=$1
    ORDER BY id DESC
    `,
  ];

  for (const sql of tries) {
    try {
      const q = await pool.query(sql, [caseId]);
      return res.json(q.rows || []);
    } catch (e) {
      if (isMissingTable(e)) return res.json([]);
      if (isMissingColumn(e)) continue;
      return res.json([]);
    }
  }

  return res.json([]);
});

app.post("/cases/:id/docs", auth, async (req, res) => {
  try {
    const caseId = Number(req.params.id);
    if (!caseId) return res.status(400).json({ error: "invalid_case_id" });

    const ok = await canAccessCase(caseId, req.user);
    if (!ok) return res.status(403).json({ error: "forbidden" });

    const name = String(req.body?.name || "").trim();
    const fileUrl = req.body?.fileUrl || req.body?.file_url || null;
    if (!name) return res.status(400).json({ error: "name_required" });

    try {
      const q = await pool.query(
        `
        INSERT INTO case_documents (case_id, name, file_url, uploaded_by, uploaded_at)
        VALUES ($1,$2,$3,$4,NOW())
        RETURNING
          id,
          case_id AS "caseId",
          name AS "name",
          file_url AS "fileUrl",
          uploaded_by AS "uploadedBy",
          uploaded_at AS "uploadedAt"
        `,
        [caseId, name, fileUrl, Number(req.user.id)]
      );

      return res.status(201).json(q.rows[0]);
    } catch (e) {
      if (isMissingTable(e)) return res.status(400).json({ error: "docs_table_missing" });
      throw e;
    }
  } catch (e) {
    console.error("POST /cases/:id/docs error:", e.message);
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

    const fileUrl = `/uploads/${req.file.filename}`;
    const name = req.body?.name || req.file.originalname;

    const q = await pool.query(
      `
      INSERT INTO case_documents
        (case_id, name, file_url, uploaded_by, uploaded_at)
      VALUES ($1,$2,$3,$4,NOW())
      RETURNING
        id,
        case_id AS "caseId",
        name AS "name",
        file_url AS "fileUrl",
        uploaded_by AS "uploadedBy",
        uploaded_at AS "uploadedAt"
      `,
      [caseId, String(name), String(fileUrl), Number(req.user.id)]
    );

    return res.status(201).json(q.rows[0]);
  } catch (e) {
    console.error("UPLOAD DOC ERROR:", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

app.patch("/cases/:cid/docs/:docId", auth, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!mustBeManager(req, res)) return;
    const cid = Number(req.params.cid);
    const did = Number(req.params.docId);
    const name = req.body && req.body.name;
    if (!cid || !did) return res.status(400).json({ error: "invalid_doc_id" });
    if (!name || !String(name).trim()) return res.status(400).json({ error: "name_required" });

    const r = await client.query(
      `UPDATE case_documents SET name=$1 WHERE id=$2 AND case_id=$3 RETURNING *`,
      [String(name).trim(), did, cid]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: "not_found" });
    return res.json(r.rows[0]);
  } catch (e) {
    console.error("PATCH /cases/:cid/docs/:docId error:", e.message);
    return res.status(500).json({ error: "server_error" });
  } finally {
    client.release();
  }
});

app.delete("/cases/:cid/docs/:docId", auth, async (req, res) => {
  try {
    const caseId = Number(req.params.cid);
    const docId = Number(req.params.docId);
    if (!caseId || !docId) return res.status(400).json({ error: "invalid_ids" });

    const ok = await canAccessCase(caseId, req.user);
    if (!ok) return res.status(403).json({ error: "forbidden" });

    try {
      const q = await pool.query(
        `DELETE FROM case_documents WHERE id=$1 AND case_id=$2 RETURNING id`,
        [docId, caseId]
      );
      if (!q.rowCount) return res.status(404).json({ error: "not_found" });
      return res.json({ ok: true });
    } catch (e) {
      if (isMissingTable(e)) return res.json({ ok: true });
      throw e;
    }
  } catch (e) {
    console.error("DELETE /cases/:cid/docs/:docId error:", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

/* =====================================================
   Notes
===================================================== */
app.get("/cases/:id/notes", auth, async (req, res) => {
  try {
    const caseId = Number(req.params.id);
    if (!caseId) return res.json([]);

    const ok = await canAccessCase(caseId, req.user);
    if (!ok) return res.status(403).json({ error: "forbidden" });

    try {
      const q = await pool.query(
        `
        SELECT
          id,
          case_id AS "caseId",
          body,
          created_by AS "createdBy",
          created_at AS "createdAt"
        FROM case_notes
        WHERE case_id=$1
        ORDER BY created_at DESC NULLS LAST, id DESC
        `,
        [caseId]
      );
      return res.json(q.rows || []);
    } catch (e) {
      if (isMissingTable(e)) return res.json([]);
      return res.json([]);
    }
  } catch (e) {
    console.error("GET /cases/:id/notes error:", e.message);
    return res.json([]);
  }
});

app.post("/cases/:id/notes", auth, async (req, res) => {
  try {
    const caseId = Number(req.params.id);
    if (!caseId) return res.status(400).json({ error: "invalid_case_id" });

    const ok = await canAccessCase(caseId, req.user);
    if (!ok) return res.status(403).json({ error: "forbidden" });

    const body = String(req.body?.body || "").trim();
    if (!body) return res.status(400).json({ error: "body_required" });

    try {
      const q = await pool.query(
        `
        INSERT INTO case_notes (case_id, body, created_by, created_at)
        VALUES ($1,$2,$3,NOW())
        RETURNING
          id,
          case_id AS "caseId",
          body,
          created_by AS "createdBy",
          created_at AS "createdAt"
        `,
        [caseId, body, Number(req.user.id)]
      );
      return res.status(201).json(q.rows[0]);
    } catch (e) {
      if (isMissingTable(e)) return res.status(400).json({ error: "notes_table_missing" });
      throw e;
    }
  } catch (e) {
    console.error("POST /cases/:id/notes error:", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

app.delete("/cases/:cid/notes/:noteId", auth, async (req, res) => {
  try {
    const caseId = Number(req.params.cid);
    const noteId = Number(req.params.noteId);
    if (!caseId || !noteId) return res.status(400).json({ error: "invalid_ids" });

    const ok = await canAccessCase(caseId, req.user);
    if (!ok) return res.status(403).json({ error: "forbidden" });

    try {
      const q = await pool.query(
        `DELETE FROM case_notes WHERE id=$1 AND case_id=$2 RETURNING id`,
        [noteId, caseId]
      );
      if (!q.rowCount) return res.status(404).json({ error: "not_found" });
      return res.json({ ok: true });
    } catch (e) {
      if (isMissingTable(e)) return res.json({ ok: true });
      throw e;
    }
  } catch (e) {
    console.error("DELETE /cases/:cid/notes/:noteId error:", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

/* =====================================================
   Timeline
===================================================== */
app.get("/cases/:id/timeline", auth, async (req, res) => {
  try {
    const caseId = Number(req.params.id);
    if (!caseId) return res.json([]);

    const ok = await canAccessCase(caseId, req.user);
    if (!ok) return res.status(403).json({ error: "forbidden" });

    try {
      const q = await pool.query(
        `
        SELECT id, case_id AS "caseId", who, what, created_at AS "at"
        FROM activity_log
        WHERE case_id=$1
        ORDER BY created_at DESC NULLS LAST, id DESC
        LIMIT 500
        `,
        [caseId]
      );
      return res.json(q.rows || []);
    } catch (e) {
      if (isMissingTable(e)) return res.json([]);
      return res.json([]);
    }
  } catch (e) {
    console.error("GET /cases/:id/timeline error:", e.message);
    return res.json([]);
  }
});

/* =====================================================
   Notifications
===================================================== */
app.get("/notifications", auth, async (req, res) => {
  try {
    try {
      const q = await pool.query(
        `
        SELECT id, title, body, link, read, created_at AS "createdAt"
        FROM notifications
        WHERE user_id=$1
        ORDER BY created_at DESC
        LIMIT 100
        `,
        [Number(req.user.id)]
      );
      return res.json(q.rows || []);
    } catch (e) {
      if (isMissingTable(e)) return res.json([]);
      return res.json([]);
    }
  } catch (e) {
    console.error("GET /notifications error:", e.message);
    return res.json([]);
  }
});

app.post("/notifications/:id/read", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "invalid_id" });

    try {
      await pool.query(
        `UPDATE notifications SET read=true WHERE id=$1 AND user_id=$2`,
        [id, Number(req.user.id)]
      );
      return res.json({ ok: true });
    } catch (e) {
      if (isMissingTable(e)) return res.json({ ok: true });
      return res.json({ ok: true });
    }
  } catch (e) {
    console.error("POST /notifications/:id/read error:", e.message);
    return res.json({ ok: true });
  }
});

/* =====================================================
   My Tasks
===================================================== */
app.get("/my/tasks", auth, async (req, res) => {
  try {
    const q = await pool.query(
      `
      SELECT
        id,
        user_id AS "userId",
        title,
        done,
        due_at AS "dueAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM my_tasks
      WHERE user_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 500
      `,
      [Number(req.user.id)]
    );
    return res.json(q.rows || []);
  } catch (e) {
    if (isMissingTable(e)) return res.json([]);
    console.error("GET /my/tasks error:", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

app.post("/my/tasks", auth, async (req, res) => {
  try {
    const title = String(req.body?.title || "").trim();
    const due_at = req.body?.due_at ?? null;
    if (!title) return res.status(400).json({ error: "title_required" });

    try {
      const q = await pool.query(
        `
        INSERT INTO my_tasks (user_id, title, done, due_at, created_at, updated_at)
        VALUES ($1,$2,false,$3,NOW(),NOW())
        RETURNING
          id,
          user_id AS "userId",
          title,
          done,
          due_at AS "dueAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        `,
        [Number(req.user.id), title, due_at]
      );
      return res.status(201).json(q.rows[0]);
    } catch (e) {
      if (isMissingTable(e)) return res.status(400).json({ error: "tasks_table_missing" });
      throw e;
    }
  } catch (e) {
    console.error("POST /my/tasks error:", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

/* =====================================================
   Drafts
===================================================== */
app.get("/drafts", auth, async (req, res) => {
  try {
    const status = req.query?.status ? String(req.query.status) : null;
    const caseId = req.query?.caseId ? Number(req.query.caseId) : null;

    try {
      const where = [];
      const vals = [];
      let i = 1;

      if (status && status !== "all") { where.push(`status=$${i++}`); vals.push(status); }
      if (caseId) { where.push(`case_id=$${i++}`); vals.push(caseId); }

      const sql = `
        SELECT
          id,
          case_id AS "caseId",
          title,
          body,
          status,
          created_by AS "createdBy",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM drafts
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY created_at DESC NULLS LAST, id DESC
        LIMIT 500
      `;

      const q = await pool.query(sql, vals);
      return res.json(q.rows || []);
    } catch (e) {
      if (isMissingTable(e)) return res.json([]);
      throw e;
    }
  } catch (e) {
    console.error("GET /drafts error:", e.message);
    return res.json([]);
  }
});

app.post("/drafts", auth, async (req, res) => {
  try {
    const payload = req.body || {};
    const caseId = payload.case_id ?? payload.caseId ?? null;
    const title = String(payload.title || "مسودة").trim();
    const body = payload.body ?? payload.content ?? "";

    if (caseId) {
      const ok = await canAccessCase(Number(caseId), req.user);
      if (!ok) return res.status(403).json({ error: "forbidden" });
    }

    try {
      const q = await pool.query(
        `
        INSERT INTO drafts (case_id, title, body, status, created_by, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,NOW(),NOW())
        RETURNING
          id,
          case_id AS "caseId",
          title,
          body,
          status,
          created_by AS "createdBy",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        `,
        [caseId ? Number(caseId) : null, title, body, payload.status || "pending", Number(req.user.id)]
      );
      return res.status(201).json(q.rows[0]);
    } catch (e) {
      if (isMissingTable(e)) return res.status(400).json({ error: "drafts_table_missing" });
      throw e;
    }
  } catch (e) {
    console.error("POST /drafts error:", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

app.patch("/drafts/:id", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "invalid_id" });

    const patch = req.body || {};
    const fields = [];
    const vals = [];
    let i = 1;

    if (patch.title !== undefined) { fields.push(`title=$${i++}`); vals.push(patch.title); }
    if (patch.body !== undefined) { fields.push(`body=$${i++}`); vals.push(patch.body); }
    if (patch.status !== undefined) { fields.push(`status=$${i++}`); vals.push(patch.status); }

    if (!fields.length) return res.status(400).json({ error: "nothing_to_update" });

    try {
      const q = await pool.query(
        `
        UPDATE drafts
        SET ${fields.join(", ")}, updated_at=NOW()
        WHERE id=$${i}
        RETURNING
          id,
          case_id AS "caseId",
          title,
          body,
          status,
          created_by AS "createdBy",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        `,
        [...vals, id]
      );
      if (!q.rowCount) return res.status(404).json({ error: "not_found" });
      return res.json(q.rows[0]);
    } catch (e) {
      if (isMissingTable(e)) return res.status(400).json({ error: "drafts_table_missing" });
      throw e;
    }
  } catch (e) {
    console.error("PATCH /drafts/:id error:", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

app.delete("/drafts/:id", auth, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!mustBeManager(req, res)) return;
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "draft_id_required" });
    const r = await client.query(`DELETE FROM drafts WHERE id=$1 RETURNING id`, [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: "not_found" });
    return res.json({ ok: true });
  } catch (e) {
    console.error("DELETE /drafts/:id error:", e.message);
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
