import express from "express";
import pkg from "pg";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const { Pool } = pkg;

// Form 4 subjects now live in the `subjects` table (admin can add/remove them);
// this is only the one-time seed used the first time the table is empty.
const DEFAULT_SUBJECTS = [
  ["mathematics", "Mathematics"],
  ["physics", "Physics"],
  ["chemistry", "Chemistry"],
  ["biology", "Biology"],
  ["english", "English"],
  ["af_soomaali", "Af-Soomaali"],
  ["arabic", "Arabic"],
  ["history", "History"],
  ["geography", "Geography"],
  ["business_studies", "Business Studies"],
  ["tarbiyo", "Tarbiyo"],
  ["ict", "ICT"],
];
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// ---------- Database ----------
if (!process.env.DATABASE_URL) {
  console.warn(
    "⚠️  DATABASE_URL lama helin. Ku dar Postgres plugin Railway-ga oo ku xidh variable-ka DATABASE_URL adeeggan."
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("railway")
    ? { rejectUnauthorized: false }
    : false,
});

async function initDb() {
  await pool.query(`CREATE TABLE IF NOT EXISTS teachers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    subject TEXT DEFAULT '',
    token TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS evaluations (
    id TEXT PRIMARY KEY,
    teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    items JSONB NOT NULL DEFAULT '[]',
    score NUMERIC NOT NULL DEFAULT 0,
    meta JSONB NOT NULL DEFAULT '{}',
    notes TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT now()
  )`);
  // Migration safety: if an older deploy created the table with the old columns,
  // make sure the new columns exist too.
  await pool.query(`ALTER TABLE evaluations ADD COLUMN IF NOT EXISTS items JSONB NOT NULL DEFAULT '[]'`);
  await pool.query(`ALTER TABLE evaluations ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '{}'`);
  await pool.query(`ALTER TABLE evaluations ADD COLUMN IF NOT EXISTS score NUMERIC NOT NULL DEFAULT 0`);
  // Drop obsolete columns from the old 3-field schema (prep/classroom/assessment)
  // so inserts using the new "items" JSONB column don't fail on NOT NULL.
  await pool.query(`ALTER TABLE evaluations DROP COLUMN IF EXISTS prep`);
  await pool.query(`ALTER TABLE evaluations DROP COLUMN IF EXISTS classroom`);
  await pool.query(`ALTER TABLE evaluations DROP COLUMN IF EXISTS assessment`);

  await pool.query(`CREATE TABLE IF NOT EXISTS students (
    id TEXT PRIMARY KEY,
    adm_no TEXT DEFAULT '',
    name TEXT NOT NULL,
    gender TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    class_name TEXT NOT NULL,
    section TEXT NOT NULL DEFAULT '',
    subjects JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMPTZ DEFAULT now()
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS subjects (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    sort_order INT NOT NULL DEFAULT 0
  )`);
  const { rows: subjCount } = await pool.query("SELECT COUNT(*)::int AS c FROM subjects");
  if (subjCount[0].c === 0) {
    for (let i = 0; i < DEFAULT_SUBJECTS.length; i++) {
      await pool.query(
        "INSERT INTO subjects (id, title, sort_order) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING",
        [DEFAULT_SUBJECTS[i][0], DEFAULT_SUBJECTS[i][1], i]
      );
    }
  }

  // ---------- Scheme of Work ----------
  await pool.query(`CREATE TABLE IF NOT EXISTS sow_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sow_topics (
    id TEXT PRIMARY KEY,
    subject_key TEXT NOT NULL,
    class_name TEXT NOT NULL,
    week_no INT,
    topic TEXT NOT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sow_completions (
    topic_id TEXT PRIMARY KEY REFERENCES sow_topics(id) ON DELETE CASCADE,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_by TEXT DEFAULT ''
  )`);

  console.log("✅ Database ready");
}
initDb().catch((e) => console.error("DB init error:", e));

// ---------- Admin auth ----------
// Fudud: password ayaa lagu xaqiijiyaa header-ka x-admin-password mar walba.
function requireAdmin(req, res, next) {
  if (!process.env.ADMIN_PASSWORD) {
    return res.status(500).json({ error: "ADMIN_PASSWORD lama dejin server-ka." });
  }
  const pw = req.header("x-admin-password");
  if (pw !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

app.post("/api/login", (req, res) => {
  const { password } = req.body || {};
  if (!process.env.ADMIN_PASSWORD) {
    return res.status(500).json({ ok: false, error: "ADMIN_PASSWORD lama dejin server-ka." });
  }
  if (password === process.env.ADMIN_PASSWORD) return res.json({ ok: true });
  res.status(401).json({ ok: false });
});

// ---------- Teachers (admin) ----------
app.get("/api/teachers", requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM teachers ORDER BY name ASC");
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server error" });
  }
});

app.post("/api/teachers", requireAdmin, async (req, res) => {
  try {
    const { name, subject } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: "name required" });
    const id = crypto.randomUUID();
    const token = crypto.randomBytes(12).toString("hex");
    await pool.query(
      "INSERT INTO teachers (id, name, subject, token) VALUES ($1,$2,$3,$4)",
      [id, name.trim(), (subject || "").trim(), token]
    );
    res.json({ id, name: name.trim(), subject: (subject || "").trim(), token });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server error" });
  }
});

app.post("/api/teachers/bulk", requireAdmin, async (req, res) => {
  try {
    const { names } = req.body || {};
    if (!Array.isArray(names) || !names.length) return res.status(400).json({ error: "names required" });
    const created = [];
    for (const raw of names) {
      const name = String(raw || "").trim();
      if (!name) continue;
      const id = crypto.randomUUID();
      const token = crypto.randomBytes(12).toString("hex");
      await pool.query(
        "INSERT INTO teachers (id, name, subject, token) VALUES ($1,$2,$3,$4)",
        [id, name, "", token]
      );
      created.push({ id, name, token });
    }
    res.json({ ok: true, created: created.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server error" });
  }
});

app.delete("/api/teachers/:id", requireAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM teachers WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server error" });
  }
});

// ---------- Evaluations (admin) ----------
app.get("/api/evaluations", requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM evaluations ORDER BY date ASC");
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server error" });
  }
});

app.post("/api/evaluations", requireAdmin, async (req, res) => {
  try {
    const { teacherId, date, items, meta } = req.body || {};
    if (!teacherId || !date) return res.status(400).json({ error: "missing fields" });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: "items required" });
    // Validate + compute score server-side (rating: 1-5 scale)
    let sum = 0;
    const cleanItems = items.map((it) => {
      const rating = Number(it.rating);
      if (![1, 2, 3, 4, 5].includes(rating)) throw new Error("invalid rating");
      sum += rating;
      return {
        key: String(it.key || ""),
        title: String(it.title || ""),
        text: String(it.text || ""),
        rating,
        comment: String(it.comment || "").trim(),
      };
    });
    const score = Math.round((sum / (cleanItems.length * 5)) * 1000) / 10; // percentage, 1 decimal
    const cleanMeta = {
      school: String((meta && meta.school) || "").trim(),
      class: String((meta && meta.class) || "").trim(),
      supervisorName: String((meta && meta.supervisorName) || "").trim(),
      strengths: String((meta && meta.strengths) || "").trim(),
      improvements: String((meta && meta.improvements) || "").trim(),
      recommendations: String((meta && meta.recommendations) || "").trim(),
      followupArea: String((meta && meta.followupArea) || "").trim(),
      followupAction: String((meta && meta.followupAction) || "").trim(),
      followupDate: String((meta && meta.followupDate) || "").trim(),
      teacherSignature: String((meta && meta.teacherSignature) || "").trim(),
      supervisorSignature: String((meta && meta.supervisorSignature) || "").trim(),
    };
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO evaluations (id, teacher_id, date, items, score, meta)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, teacherId, date, JSON.stringify(cleanItems), score, JSON.stringify(cleanMeta)]
    );
    res.json({ ok: true, id, score });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e.message || "server error" });
  }
});

app.delete("/api/evaluations/:id", requireAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM evaluations WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server error" });
  }
});

// ---------- Students & subjects (admin) ----------
app.get("/api/subjects", requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT id, title FROM subjects ORDER BY sort_order ASC, title ASC");
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server error" });
  }
});

app.post("/api/subjects", requireAdmin, async (req, res) => {
  try {
    const { title } = req.body || {};
    if (!title || !title.trim()) return res.status(400).json({ error: "title required" });
    const { rows: maxRow } = await pool.query("SELECT COALESCE(MAX(sort_order),-1) AS m FROM subjects");
    const nextOrder = maxRow[0].m + 1;
    let base = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    if (!base) base = "subject";
    let id = base;
    let n = 1;
    while (true) {
      const { rows } = await pool.query("SELECT 1 FROM subjects WHERE id=$1", [id]);
      if (!rows.length) break;
      n++;
      id = base + "_" + n;
    }
    await pool.query("INSERT INTO subjects (id, title, sort_order) VALUES ($1,$2,$3)", [id, title.trim(), nextOrder]);
    res.json({ ok: true, id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server error" });
  }
});

app.delete("/api/subjects/:id", requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    await pool.query("DELETE FROM subjects WHERE id=$1", [id]);
    // also drop this subject from every student who had it
    await pool.query("UPDATE students SET subjects = subjects - $1 WHERE subjects ? $1", [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server error" });
  }
});

app.get("/api/students", requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM students ORDER BY class_name ASC, section ASC, name ASC"
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server error" });
  }
});

app.post("/api/students", requireAdmin, async (req, res) => {
  try {
    const { admNo, name, gender, phone, className, section } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: "name required" });
    if (!className || !className.trim()) return res.status(400).json({ error: "class required" });
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO students (id, adm_no, name, gender, phone, class_name, section, subjects)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'[]')`,
      [
        id,
        String(admNo || "").trim(),
        name.trim(),
        String(gender || "").trim(),
        String(phone || "").trim(),
        className.trim(),
        String(section || "").trim(),
      ]
    );
    res.json({ ok: true, id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server error" });
  }
});

app.post("/api/students/bulk", requireAdmin, async (req, res) => {
  try {
    const { rows } = req.body || {};
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: "rows required" });
    let created = 0;
    for (const r of rows) {
      const name = String((r && r.name) || "").trim();
      const className = String((r && r.className) || "").trim();
      if (!name || !className) continue;
      const id = crypto.randomUUID();
      await pool.query(
        `INSERT INTO students (id, adm_no, name, gender, phone, class_name, section, subjects)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'[]')`,
        [
          id,
          String((r && r.admNo) || "").trim(),
          name,
          String((r && r.gender) || "").trim(),
          String((r && r.phone) || "").trim(),
          className,
          String((r && r.section) || "").trim(),
        ]
      );
      created++;
    }
    res.json({ ok: true, created });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server error" });
  }
});

app.put("/api/students/:id/subjects", requireAdmin, async (req, res) => {
  try {
    const { subjects } = req.body || {};
    if (!Array.isArray(subjects)) return res.status(400).json({ error: "subjects must be an array" });
    const { rows: subRows } = await pool.query("SELECT id FROM subjects");
    const validKeys = subRows.map((r) => r.id);
    const clean = subjects.filter((s) => validKeys.includes(s));
    const { rowCount } = await pool.query(
      "UPDATE students SET subjects=$1 WHERE id=$2",
      [JSON.stringify(clean), req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: "not found" });
    res.json({ ok: true, subjects: clean });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server error" });
  }
});

app.delete("/api/students/:id", requireAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM students WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server error" });
  }
});

// ---------- Scheme of Work (admin) ----------
app.get("/api/sow/settings", requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT key, value FROM sow_settings");
    const out = {};
    for (const r of rows) out[r.key] = r.value;
    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server error" });
  }
});

app.put("/api/sow/settings", requireAdmin, async (req, res) => {
  try {
    const { termStartDate } = req.body || {};
    if (termStartDate !== undefined) {
      await pool.query(
        `INSERT INTO sow_settings (key, value) VALUES ('term_start_date', $1)
         ON CONFLICT (key) DO UPDATE SET value=$1`,
        [String(termStartDate || "")]
      );
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server error" });
  }
});

app.get("/api/sow/topics", requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT t.*, c.completed_at, c.completed_by,
             (c.topic_id IS NOT NULL) AS done
      FROM sow_topics t
      LEFT JOIN sow_completions c ON c.topic_id = t.id
      ORDER BY t.subject_key ASC, t.class_name ASC, t.sort_order ASC
    `);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server error" });
  }
});

app.post("/api/sow/topics", requireAdmin, async (req, res) => {
  try {
    const { subjectKey, className, weekNo, topic } = req.body || {};
    if (!subjectKey || !className || !topic || !String(topic).trim())
      return res.status(400).json({ error: "subjectKey, className and topic are required" });
    const { rows: maxRow } = await pool.query(
      "SELECT COALESCE(MAX(sort_order),-1) AS m FROM sow_topics WHERE subject_key=$1 AND class_name=$2",
      [subjectKey, className]
    );
    const id = crypto.randomUUID();
    await pool.query(
      "INSERT INTO sow_topics (id, subject_key, class_name, week_no, topic, sort_order) VALUES ($1,$2,$3,$4,$5,$6)",
      [id, subjectKey, className, weekNo == null || weekNo === "" ? null : Number(weekNo), String(topic).trim(), maxRow[0].m + 1]
    );
    res.json({ ok: true, id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server error" });
  }
});

// Uploading a Scheme of Work replaces whatever was previously stored for that subject+class.
app.post("/api/sow/topics/bulk", requireAdmin, async (req, res) => {
  try {
    const { subjectKey, className, rows } = req.body || {};
    if (!subjectKey || !className) return res.status(400).json({ error: "subjectKey and className required" });
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: "rows required" });
    await pool.query("DELETE FROM sow_topics WHERE subject_key=$1 AND class_name=$2", [subjectKey, className]);
    let created = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const topic = String((r && r.topic) || "").trim();
      if (!topic) continue;
      const weekNo = r && r.weekNo != null && r.weekNo !== "" ? Number(r.weekNo) : null;
      const id = crypto.randomUUID();
      await pool.query(
        "INSERT INTO sow_topics (id, subject_key, class_name, week_no, topic, sort_order) VALUES ($1,$2,$3,$4,$5,$6)",
        [id, subjectKey, className, weekNo, topic, i]
      );
      created++;
    }
    res.json({ ok: true, created });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server error" });
  }
});

app.put("/api/sow/topics/:id/toggle", requireAdmin, async (req, res) => {
  try {
    const { done, completedBy } = req.body || {};
    if (done) {
      await pool.query(
        `INSERT INTO sow_completions (topic_id, completed_by) VALUES ($1,$2)
         ON CONFLICT (topic_id) DO UPDATE SET completed_at=now(), completed_by=$2`,
        [req.params.id, String(completedBy || "")]
      );
    } else {
      await pool.query("DELETE FROM sow_completions WHERE topic_id=$1", [req.params.id]);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server error" });
  }
});

app.delete("/api/sow/topics/:id", requireAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM sow_topics WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server error" });
  }
});

// ---------- Public teacher link (no password needed - token is the secret) ----------
app.get("/api/public/:token", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM teachers WHERE token=$1", [req.params.token]);
    if (!rows.length) return res.status(404).json({ error: "not found" });
    const teacher = rows[0];
    const evalsRes = await pool.query(
      "SELECT * FROM evaluations WHERE teacher_id=$1 ORDER BY date ASC",
      [teacher.id]
    );
    res.json({
      teacher: { name: teacher.name, subject: teacher.subject },
      evaluations: evalsRes.rows,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server error" });
  }
});

// ---------- Static pages ----------
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  },
}));

app.get("/t/:token", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "teacher.html"));
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server wuxuu ku shaqeynayaa port ${PORT}`));
