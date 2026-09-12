// FILE: C:\faris-api\routes-extra.mjs
// مسارات إضافية: notifications / drafts / my-tasks / case-notes / timeline / articles
// تُركّب من index.js:  mountExtra(app, pool, { auth, roleOf, canAccessCase })
// كل الجداول موجودة مسبقًا في قاعدة البيانات عدا "articles" (يُنشأ تلقائيًا عند الإقلاع).

export default function mountExtra(app, pool, deps) {
  const { auth, roleOf, canAccessCase } = deps;
  const isManager = (u) => roleOf(u) === "manager";

  /* ---- إنشاء جدول المقالات (آمن، لا يلمس بياناتك) ---- */
  (async () => {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS public.articles (
          id            serial PRIMARY KEY,
          title         text NOT NULL,
          content       text NOT NULL,
          status        text NOT NULL DEFAULT 'pending',
          author_id     integer REFERENCES public.users(id) ON DELETE SET NULL,
          author_name   text,
          created_at    timestamptz NOT NULL DEFAULT now(),
          updated_at    timestamptz NOT NULL DEFAULT now(),
          published_at  timestamptz
        )`);
      console.log("✅ articles table ready");
    } catch (e) {
      console.error("articles table error:", e.message);
    }
  })();

  /* ---- إنشاء جدول المعاملات المالية (آمن، لا يلمس بياناتك) ---- */
  (async () => {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS public.financial_transactions (
          id            serial PRIMARY KEY,
          type          text NOT NULL CHECK (type IN ('income','expense','due')),
          amount        numeric NOT NULL CHECK (amount > 0),
          case_number   text,
          case_label    text,
          tx_date       date NOT NULL DEFAULT CURRENT_DATE,
          description   text,
          created_by    integer REFERENCES public.users(id) ON DELETE SET NULL,
          created_at    timestamptz NOT NULL DEFAULT now()
        )`);
      console.log("✅ financial_transactions table ready");
    } catch (e) {
      console.error("financial_transactions table error:", e.message);
    }
  })();

  async function notify(client, userId, title, body, link) {
    if (!userId) return;
    try {
      await (client || pool).query(
        `INSERT INTO public.notifications (user_id, title, body, link, read, created_at)
         VALUES ($1,$2,$3,$4,false,now())`,
        [Number(userId), String(title || "").slice(0, 300), String(body || "").slice(0, 1000), link || null]
      );
    } catch (e) {
      console.error("notify error:", e.message);
    }
  }
  async function managerIds() {
    try {
      const q = await pool.query(`SELECT id FROM public.users WHERE role='manager'`);
      return q.rows.map((r) => r.id);
    } catch { return []; }
  }
  app.set("faris_notify", notify);
  app.set("faris_managerIds", managerIds);

  /* ===================== Notifications ===================== */
  app.get("/notifications", auth, async (req, res) => {
    try {
      const unread = String(req.query.unread || "") === "1";
      const q = await pool.query(
        `SELECT id, title, body, link, read, created_at AS "createdAt"
           FROM public.notifications
          WHERE user_id = $1 ${unread ? "AND read = false" : ""}
          ORDER BY created_at DESC NULLS LAST, id DESC
          LIMIT 100`,
        [Number(req.user.id)]
      );
      res.json(q.rows || []);
    } catch (e) {
      console.error("GET /notifications:", e);
      res.status(500).json({ error: "server_error" });
    }
  });

  app.post("/notifications/:id/read", auth, async (req, res) => {
    try {
      const q = await pool.query(
        `UPDATE public.notifications SET read = true WHERE id = $1 AND user_id = $2 RETURNING id`,
        [Number(req.params.id), Number(req.user.id)]
      );
      if (!q.rowCount) return res.status(404).json({ error: "not_found" });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: "server_error" });
    }
  });

  app.post("/notifications/read-all", auth, async (req, res) => {
    try {
      await pool.query(`UPDATE public.notifications SET read = true WHERE user_id = $1 AND read = false`, [
        Number(req.user.id),
      ]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: "server_error" });
    }
  });

  /* ===================== Drafts ===================== */
  app.get("/drafts", auth, async (req, res) => {
    try {
      const conds = [];
      const vals = [];
      if (!isManager(req.user)) { vals.push(Number(req.user.id)); conds.push(`author_id = $${vals.length}`); }
      const status = String(req.query.status || "").trim();
      if (status && status !== "all") { vals.push(status); conds.push(`status = $${vals.length}`); }
      const caseId = Number(req.query.caseId);
      if (caseId) { vals.push(caseId); conds.push(`case_id = $${vals.length}`); }
      const where = conds.length ? "WHERE " + conds.join(" AND ") : "";
      const q = await pool.query(
        `SELECT id, title, body, case_id AS "caseId", status,
                created_at AS "ts", author_id AS "authorId"
           FROM public.drafts ${where}
          ORDER BY created_at DESC NULLS LAST, id DESC`,
        vals
      );
      res.json(q.rows || []);
    } catch (e) {
      console.error("GET /drafts:", e);
      res.status(500).json({ error: "server_error" });
    }
  });

  app.post("/drafts", auth, async (req, res) => {
    try {
      const title = String(req.body?.title || "").trim();
      const body = String(req.body?.body || "").trim();
      const caseId = req.body?.caseId ? Number(req.body.caseId) : null;
      if (!title) return res.status(400).json({ error: "title_required" });
      const q = await pool.query(
        `INSERT INTO public.drafts (title, body, case_id, status, author_id, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,'pending',$4,$4,now(),now())
         RETURNING id, title, body, case_id AS "caseId", status, created_at AS "ts", author_id AS "authorId"`,
        [title, body, caseId, Number(req.user.id)]
      );
      for (const mid of await managerIds()) {
        if (mid !== Number(req.user.id)) await notify(null, mid, "مسودة جديدة بانتظار الاعتماد", title, "/admin/drafts");
      }
      res.status(201).json(q.rows[0]);
    } catch (e) {
      console.error("POST /drafts:", e);
      res.status(500).json({ error: "server_error" });
    }
  });

  app.patch("/drafts/:id", auth, async (req, res) => {
    try {
      const cur = await pool.query(`SELECT * FROM public.drafts WHERE id = $1`, [Number(req.params.id)]);
      if (!cur.rowCount) return res.status(404).json({ error: "not_found" });
      const d = cur.rows[0];
      const mgr = isManager(req.user);
      const owner = Number(d.author_id) === Number(req.user.id);
      if (!mgr && !owner) return res.status(403).json({ error: "forbidden" });

      const sets = [], vals = [];
      const push = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
      if (typeof req.body?.title === "string" && req.body.title.trim()) push("title", req.body.title.trim());
      if (typeof req.body?.body === "string") push("body", req.body.body);
      if (mgr && typeof req.body?.status === "string") {
        if (!["pending", "approved", "rejected"].includes(req.body.status)) return res.status(400).json({ error: "bad_status" });
        push("status", req.body.status);
      }
      if (!sets.length) return res.json(d);
      vals.push(Number(req.params.id));
      const q = await pool.query(
        `UPDATE public.drafts SET ${sets.join(", ")}, updated_at = now() WHERE id = $${vals.length}
         RETURNING id, title, body, case_id AS "caseId", status, created_at AS "ts", author_id AS "authorId"`,
        vals
      );
      if (mgr && req.body?.status && req.body.status !== d.status && d.author_id) {
        const label = req.body.status === "approved" ? "تم اعتماد مسودتك" : req.body.status === "rejected" ? "تم رفض مسودتك" : "تحديث حالة مسودتك";
        await notify(null, d.author_id, label, d.title, "/staff");
      }
      res.json(q.rows[0]);
    } catch (e) {
      console.error("PATCH /drafts/:id:", e);
      res.status(500).json({ error: "server_error" });
    }
  });

  app.delete("/drafts/:id", auth, async (req, res) => {
    try {
      const cur = await pool.query(`SELECT author_id FROM public.drafts WHERE id = $1`, [Number(req.params.id)]);
      if (!cur.rowCount) return res.status(404).json({ error: "not_found" });
      if (!isManager(req.user) && Number(cur.rows[0].author_id) !== Number(req.user.id))
        return res.status(403).json({ error: "forbidden" });
      await pool.query(`DELETE FROM public.drafts WHERE id = $1`, [Number(req.params.id)]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: "server_error" });
    }
  });

  /* ===================== My tasks ===================== */
  app.get("/my/tasks", auth, async (req, res) => {
    try {
      const q = await pool.query(
        `SELECT id, title, done, due_at, due_at AS "dueAt", created_at AS "createdAt", updated_at AS "updatedAt"
           FROM public.my_tasks WHERE user_id = $1
          ORDER BY done ASC, due_at ASC NULLS LAST, id DESC`,
        [Number(req.user.id)]
      );
      res.json(q.rows || []);
    } catch (e) {
      console.error("GET /my/tasks:", e);
      res.status(500).json({ error: "server_error" });
    }
  });

  app.post("/my/tasks", auth, async (req, res) => {
    try {
      const title = String(req.body?.title || "").trim();
      if (!title) return res.status(400).json({ error: "title_required" });
      const dueAt = req.body?.due_at || req.body?.dueAt || null;
      const q = await pool.query(
        `INSERT INTO public.my_tasks (user_id, title, done, due_at, created_at, updated_at)
         VALUES ($1,$2,false,$3,now(),now())
         RETURNING id, title, done, due_at, due_at AS "dueAt", created_at AS "createdAt"`,
        [Number(req.user.id), title, dueAt]
      );
      res.status(201).json(q.rows[0]);
    } catch (e) {
      console.error("POST /my/tasks:", e);
      res.status(500).json({ error: "server_error" });
    }
  });

  app.patch("/my/tasks/:id", auth, async (req, res) => {
    try {
      const sets = [], vals = [];
      const push = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
      if (typeof req.body?.done === "boolean") push("done", req.body.done);
      if ("due_at" in (req.body || {}) || "dueAt" in (req.body || {}))
        push("due_at", req.body.due_at ?? req.body.dueAt ?? null);
      if (typeof req.body?.title === "string" && req.body.title.trim()) push("title", req.body.title.trim());
      if (!sets.length) return res.status(400).json({ error: "nothing_to_update" });
      vals.push(Number(req.params.id), Number(req.user.id));
      const q = await pool.query(
        `UPDATE public.my_tasks SET ${sets.join(", ")}, updated_at = now()
          WHERE id = $${vals.length - 1} AND user_id = $${vals.length}
         RETURNING id, title, done, due_at, due_at AS "dueAt"`,
        vals
      );
      if (!q.rowCount) return res.status(404).json({ error: "not_found" });
      res.json(q.rows[0]);
    } catch (e) {
      console.error("PATCH /my/tasks/:id:", e);
      res.status(500).json({ error: "server_error" });
    }
  });

  app.delete("/my/tasks/:id", auth, async (req, res) => {
    try {
      const q = await pool.query(`DELETE FROM public.my_tasks WHERE id = $1 AND user_id = $2 RETURNING id`, [
        Number(req.params.id), Number(req.user.id),
      ]);
      if (!q.rowCount) return res.status(404).json({ error: "not_found" });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: "server_error" });
    }
  });

  /* /tasks — دفاعي: الواجهة تتسامح مع الفراغ */
  app.get("/tasks", auth, async (_req, res) => res.json([]));

  /* ===================== Case notes ===================== */
  app.get("/cases/:id/notes", auth, async (req, res) => {
    try {
      const caseId = Number(req.params.id);
      if (!caseId) return res.json([]);
      const ok = await canAccessCase(caseId, req.user);
      if (!ok) return res.status(403).json({ error: "forbidden" });
      const q = await pool.query(
        `SELECT id, body, body AS txt, created_by AS by, created_by AS "createdBy",
                created_at AS "createdAt", created_at AS ts
           FROM public.case_notes WHERE case_id = $1
          ORDER BY created_at DESC NULLS LAST, id DESC`,
        [caseId]
      );
      res.json(q.rows || []);
    } catch (e) {
      console.error("GET /cases/:id/notes:", e);
      res.json([]);
    }
  });

  app.post("/cases/:id/notes", auth, async (req, res) => {
    try {
      const caseId = Number(req.params.id);
      if (!caseId) return res.status(400).json({ error: "invalid_case_id" });
      const ok = await canAccessCase(caseId, req.user);
      if (!ok) return res.status(403).json({ error: "forbidden" });
      const body = String(req.body?.body || req.body?.txt || "").trim();
      if (!body) return res.status(400).json({ error: "body_required" });
      const q = await pool.query(
        `INSERT INTO public.case_notes (case_id, body, created_by, created_at)
         VALUES ($1,$2,$3,now())
         RETURNING id, body, body AS txt, created_by AS by, created_at AS "createdAt"`,
        [caseId, body, String(req.user.id)]
      );
      res.status(201).json(q.rows[0]);
    } catch (e) {
      console.error("POST /cases/:id/notes:", e);
      res.status(500).json({ error: "server_error" });
    }
  });

  app.delete("/cases/:cid/notes/:nid", auth, async (req, res) => {
    try {
      const cur = await pool.query(`SELECT created_by FROM public.case_notes WHERE id = $1 AND case_id = $2`, [
        Number(req.params.nid), Number(req.params.cid),
      ]);
      if (!cur.rowCount) return res.status(404).json({ error: "not_found" });
      if (!isManager(req.user) && String(cur.rows[0].created_by) !== String(req.user.id))
        return res.status(403).json({ error: "forbidden" });
      await pool.query(`DELETE FROM public.case_notes WHERE id = $1`, [Number(req.params.nid)]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: "server_error" });
    }
  });

  /* ===================== Case timeline (من activity_log) ===================== */
  app.get("/cases/:id/timeline", auth, async (req, res) => {
    try {
      const caseId = Number(req.params.id);
      if (!caseId) return res.json([]);
      const ok = await canAccessCase(caseId, req.user);
      if (!ok) return res.status(403).json({ error: "forbidden" });
      const q = await pool.query(
        `SELECT id,
                COALESCE(NULLIF(what,''), NULLIF(action,''), 'حدث') AS what,
                COALESCE(NULLIF(what,''), NULLIF(action,''), 'حدث') AS action,
                who, created_at AS at, created_at AS "createdAt", meta
           FROM public.activity_log WHERE case_id = $1
          ORDER BY created_at DESC NULLS LAST, id DESC
          LIMIT 200`,
        [caseId]
      );
      res.json(q.rows || []);
    } catch (e) {
      console.error("GET /cases/:id/timeline:", e);
      res.json([]);
    }
  });

  /* ===================== Articles ===================== */
  const artOut = (r) => ({
    id: r.id, title: r.title, content: r.content, status: r.status,
    author_id: r.author_id, author_name: r.author_name,
    created_at: r.created_at, updated_at: r.updated_at, published_at: r.published_at,
  });

  // عام: المقالات المنشورة
  app.get("/articles", async (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
      const q = await pool.query(
        `SELECT * FROM public.articles WHERE status = 'published'
          ORDER BY published_at DESC NULLS LAST, created_at DESC LIMIT $1`,
        [limit]
      );
      res.json(q.rows.map(artOut));
    } catch (e) {
      console.error("GET /articles:", e);
      res.status(500).json({ error: "server_error" });
    }
  });

  // محمي: مقالاتي
  app.get("/articles/mine", auth, async (req, res) => {
    try {
      const q = await pool.query(
        `SELECT * FROM public.articles WHERE author_id = $1 ORDER BY created_at DESC`,
        [Number(req.user.id)]
      );
      res.json(q.rows.map(artOut));
    } catch (e) {
      res.status(500).json({ error: "server_error" });
    }
  });

  // محمي (مدير): قيد المراجعة
  app.get("/articles/pending", auth, async (req, res) => {
    try {
      if (!isManager(req.user)) return res.status(403).json({ error: "forbidden" });
      const q = await pool.query(`SELECT * FROM public.articles WHERE status='pending' ORDER BY created_at DESC`);
      res.json(q.rows.map(artOut));
    } catch (e) {
      res.status(500).json({ error: "server_error" });
    }
  });

  // عام: مقال واحد (المنشور للجميع؛ غيره لصاحبه/المدير)
  app.get("/articles/:id", async (req, res) => {
    try {
      const q = await pool.query(`SELECT * FROM public.articles WHERE id = $1`, [Number(req.params.id)]);
      if (!q.rowCount) return res.status(404).json({ error: "not_found" });
      const a = q.rows[0];
      if (a.status !== "published") {
        // تحقّق اختياري من التوكن
        let uid = null, role = null;
        const h = req.headers.authorization || "";
        const t = h.startsWith("Bearer ") ? h.slice(7) : null;
        if (t) {
          try {
            const jwt = (await import("jsonwebtoken")).default;
            const p = jwt.verify(t, process.env.JWT_SECRET || "dev-secret-faris");
            uid = p.id; role = String(p.role || "").toLowerCase();
          } catch { /* ignore */ }
        }
        if (!(role === "manager" || Number(uid) === Number(a.author_id))) return res.status(404).json({ error: "not_found" });
      }
      res.json(artOut(a));
    } catch (e) {
      res.status(500).json({ error: "server_error" });
    }
  });

  // محمي: إنشاء
  app.post("/articles", auth, async (req, res) => {
    try {
      const role = roleOf(req.user);
      if (role !== "manager" && role !== "staff") return res.status(403).json({ error: "forbidden" });
      const title = String(req.body?.title || "").trim();
      const content = String(req.body?.content || "").trim();
      if (!title || !content) return res.status(400).json({ error: "title_and_content_required" });

      const u = await pool.query(`SELECT full_name, email FROM public.users WHERE id = $1`, [Number(req.user.id)]);
      const authorName = u.rows[0]?.full_name || u.rows[0]?.email || null;
      const publish = role === "manager";
      const q = await pool.query(
        `INSERT INTO public.articles (title, content, status, author_id, author_name, published_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,now()) RETURNING *`,
        [title, content, publish ? "published" : "pending", Number(req.user.id), authorName, publish ? new Date() : null]
      );
      if (!publish) {
        for (const mid of await managerIds()) await notify(null, mid, "مقال جديد بانتظار المراجعة", title, "/admin/articles");
      }
      res.status(201).json(artOut(q.rows[0]));
    } catch (e) {
      console.error("POST /articles:", e);
      res.status(500).json({ error: "server_error" });
    }
  });

  // محمي: تعديل
  app.patch("/articles/:id", auth, async (req, res) => {
    try {
      const cur = await pool.query(`SELECT * FROM public.articles WHERE id = $1`, [Number(req.params.id)]);
      if (!cur.rowCount) return res.status(404).json({ error: "not_found" });
      const a = cur.rows[0];
      const mgr = isManager(req.user);
      const owner = Number(a.author_id) === Number(req.user.id);
      if (!mgr && !owner) return res.status(403).json({ error: "forbidden" });

      const sets = [], vals = [];
      const push = (frag, v) => { vals.push(v); sets.push(frag.replace("?", `$${vals.length}`)); };
      if (typeof req.body?.title === "string" && req.body.title.trim()) push("title = ?", req.body.title.trim());
      if (typeof req.body?.content === "string" && req.body.content.trim()) push("content = ?", req.body.content.trim());
      if (mgr && typeof req.body?.status === "string") {
        if (!["pending", "published", "rejected"].includes(req.body.status)) return res.status(400).json({ error: "bad_status" });
        push("status = ?", req.body.status);
        push("published_at = ?", req.body.status === "published" ? new Date() : null);
      }
      if (!sets.length) return res.json(artOut(a));
      vals.push(Number(req.params.id));
      const q = await pool.query(
        `UPDATE public.articles SET ${sets.join(", ")}, updated_at = now() WHERE id = $${vals.length} RETURNING *`,
        vals
      );
      if (mgr && req.body?.status && req.body.status !== a.status && a.author_id) {
        const label = req.body.status === "published" ? "تم نشر مقالك" : req.body.status === "rejected" ? "تم رفض مقالك" : "تحديث حالة مقالك";
        await notify(null, a.author_id, label, a.title, "/staff/articles");
      }
      res.json(artOut(q.rows[0]));
    } catch (e) {
      console.error("PATCH /articles/:id:", e);
      res.status(500).json({ error: "server_error" });
    }
  });

  const setArticleStatus = (target) => async (req, res) => {
    try {
      if (!isManager(req.user)) return res.status(403).json({ error: "forbidden" });
      const q = await pool.query(
        `UPDATE public.articles
            SET status = $1,
                published_at = CASE WHEN $1 = 'published' THEN now() ELSE published_at END,
                updated_at = now()
          WHERE id = $2 RETURNING *`,
        [target, Number(req.params.id)]
      );
      if (!q.rowCount) return res.status(404).json({ error: "not_found" });
      const a = q.rows[0];
      if (a.author_id) {
        const label = target === "published" ? "تم نشر مقالك" : "تم رفض مقالك";
        await notify(null, a.author_id, label, a.title, "/staff/articles");
      }
      res.json(artOut(a));
    } catch (e) {
      console.error("article status:", e);
      res.status(500).json({ error: "server_error" });
    }
  };
  app.post("/articles/:id/approve", auth, setArticleStatus("published"));
  app.post("/articles/:id/reject", auth, setArticleStatus("rejected"));

  app.delete("/articles/:id", auth, async (req, res) => {
    try {
      const cur = await pool.query(`SELECT author_id FROM public.articles WHERE id = $1`, [Number(req.params.id)]);
      if (!cur.rowCount) return res.status(404).json({ error: "not_found" });
      if (!isManager(req.user) && Number(cur.rows[0].author_id) !== Number(req.user.id))
        return res.status(403).json({ error: "forbidden" });
      await pool.query(`DELETE FROM public.articles WHERE id = $1`, [Number(req.params.id)]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: "server_error" });
    }
  });

  /* ===================== Financial (مدير فقط) ===================== */
  // ملاحظة: عمود tx_date من نوع DATE — الـ pg driver يرجّعه ككائن Date على
  // منتصف ليل بالتوقيت المحلي؛ لازم القراءة بدوال محلية (getFullYear/...)
  // لا toISOString() (تحوّل لتوقيت UTC وقد تُرجع اليوم السابق).
  function toDateOnly(v) {
    if (v instanceof Date) {
      const y = v.getFullYear(), m = String(v.getMonth() + 1).padStart(2, "0"), d = String(v.getDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    }
    return String(v || "").slice(0, 10);
  }
  // "اليوم" بتوقيت الرياض تحديدًا — بدلاً من توقيت السيرفر (UTC عادة)، حتى لا
  // يظهر تاريخ الأمس لمن يضيف معاملة بين منتصف الليل والثالثة فجرًا بتوقيت السعودية.
  function riyadhToday() {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    const get = (t) => parts.find((p) => p.type === t).value;
    return `${get("year")}-${get("month")}-${get("day")}`;
  }
  function finOut(r) {
    return {
      id: r.id,
      type: r.type,
      amount: Number(r.amount),
      caseId: r.case_number || "",
      caseLabel: r.case_label || "",
      date: toDateOnly(r.tx_date),
      desc: r.description || "",
    };
  }

  app.get("/financial/transactions", auth, async (req, res) => {
    try {
      if (!isManager(req.user)) return res.status(403).json({ error: "forbidden" });
      const q = await pool.query(
        `SELECT id, type, amount, case_number, case_label, tx_date, description
           FROM public.financial_transactions
          ORDER BY tx_date DESC, id DESC`
      );
      res.json(q.rows.map(finOut));
    } catch (e) {
      console.error("GET /financial/transactions:", e);
      res.status(500).json({ error: "server_error" });
    }
  });

  app.post("/financial/transactions", auth, async (req, res) => {
    try {
      if (!isManager(req.user)) return res.status(403).json({ error: "forbidden" });
      const type = String(req.body?.type || "");
      if (!["income", "expense", "due"].includes(type)) return res.status(400).json({ error: "bad_type" });
      const amount = Number(req.body?.amount);
      if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: "bad_amount" });
      const caseNumber = req.body?.caseId ? String(req.body.caseId).trim() : null;
      const caseLabel = req.body?.caseLabel ? String(req.body.caseLabel).trim() : null;
      const date = req.body?.date ? String(req.body.date) : riyadhToday();
      const desc = req.body?.desc ? String(req.body.desc).trim().slice(0, 500) : null;

      const q = await pool.query(
        `INSERT INTO public.financial_transactions
           (type, amount, case_number, case_label, tx_date, description, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [type, amount, caseNumber, caseLabel, date, desc, Number(req.user.id)]
      );
      res.status(201).json(finOut(q.rows[0]));
    } catch (e) {
      console.error("POST /financial/transactions:", e);
      res.status(500).json({ error: "server_error" });
    }
  });

  app.delete("/financial/transactions/:id", auth, async (req, res) => {
    try {
      if (!isManager(req.user)) return res.status(403).json({ error: "forbidden" });
      await pool.query(`DELETE FROM public.financial_transactions WHERE id = $1`, [Number(req.params.id)]);
      res.json({ ok: true });
    } catch (e) {
      console.error("DELETE /financial/transactions/:id:", e);
      res.status(500).json({ error: "server_error" });
    }
  });

  console.log("✅ extra routes mounted (notifications / drafts / my-tasks / notes / timeline / articles / financial)");
}
