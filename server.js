import express from "express";
import pkg from "pg";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const { Pool } = pkg;
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
    prep INT NOT NULL,
    classroom INT NOT NULL,
    assessment INT NOT NULL,
    notes TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT now()
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
    const { teacherId, date, prep, classroom, assessment, notes } = req.body || {};
    if (!teacherId || !date) return res.status(400).json({ error: "missing fields" });
    const p = Number(prep), c = Number(classroom), a = Number(assessment);
    if ([p, c, a].some((n) => !Number.isFinite(n) || n < 1 || n > 10)) {
      return res.status(400).json({ error: "scores must be 1-10" });
    }
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO evaluations (id, teacher_id, date, prep, classroom, assessment, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, teacherId, date, p, c, a, (notes || "").trim()]
    );
    res.json({ ok: true, id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server error" });
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
app.use(express.static(path.join(__dirname, "public")));

app.get("/t/:token", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "teacher.html"));
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server wuxuu ku shaqeynayaa port ${PORT}`));
