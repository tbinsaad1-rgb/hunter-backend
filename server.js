const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const { processExcelBuffer } = require('./upload_handler');
const { normalizePlate } = require('./plate_parser');
const { createAndSendOtp, verifyOtp, isEmailConfigured } = require('./otp');
const webauthn = require('./webauthn');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const app = express();
app.use((req, res, next) => { res.setTimeout(15000, () => res.status(408).json({error:'انتهت مهلة الطلب'})); next(); });
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'hunter-secret-change-in-production-2024';

// CORS - يقبل كل المصادر
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
// JSON parser — لا يطبق على multipart/form-data (ملفات Excel)
app.use((req, res, next) => {
  const ct = req.headers['content-type'] || '';
  if (ct.includes('multipart/form-data')) return next();
  express.json({ limit: '50mb' })(req, res, next);
});
app.use((req, res, next) => {
  const ct = req.headers['content-type'] || '';
  if (ct.includes('multipart/form-data')) return next();
  express.urlencoded({ extended: true, limit: '50mb' })(req, res, next);
});

// ── قاعدة البيانات ──────────────────────────────────────────────
// قاعدة البيانات — تُحفظ في مجلد دائم (Volume) إذا متوفر، وإلا في مجلد الكود
const DB_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const db = new Database(path.join(DB_DIR, 'hunter.db'));
console.log('📁 قاعدة البيانات في:', path.join(DB_DIR, 'hunter.db'));
// إيقاف foreign key constraints لأن السجلات يجب تبقى حتى بعد حذف المستخدم
db.pragma('foreign_keys = OFF');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'agent',
    group_name TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    device_id TEXT,
    can_export_scans INTEGER NOT NULL DEFAULT 0,
    can_export_wanted INTEGER NOT NULL DEFAULT 0,
    can_voice_scan INTEGER NOT NULL DEFAULT 0,
    can_manage_portfolios INTEGER DEFAULT 0,
    can_check INTEGER DEFAULT 0,
    can_use_web INTEGER DEFAULT 0,
    email TEXT,
    otp_enabled INTEGER DEFAULT 0,
    device_lock INTEGER DEFAULT 0,
    monthly_goal INTEGER DEFAULT 1000,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS scans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plate TEXT NOT NULL,
    plate_spaced TEXT,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    note TEXT,
    is_wanted INTEGER DEFAULT 0,
    wanted_company TEXT,
    wanted_model TEXT,
    wanted_portfolio TEXT,
    user_id INTEGER NOT NULL,
    user_name TEXT NOT NULL,
    group_name TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS wanted (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plate TEXT NOT NULL UNIQUE,
    reason TEXT,
    company TEXT,
    model TEXT,
    portfolio TEXT,
    added_by TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    last_portfolio_update TEXT DEFAULT (datetime('now'))
  );


  -- فهارس لتسريع البحث
  CREATE INDEX IF NOT EXISTS idx_scans_user    ON scans(user_id);
  CREATE INDEX IF NOT EXISTS idx_scans_plate   ON scans(plate);
  CREATE INDEX IF NOT EXISTS idx_scans_date    ON scans(created_at);
  CREATE INDEX IF NOT EXISTS idx_wanted_plate  ON wanted(plate);
  CREATE INDEX IF NOT EXISTS idx_wanted_port   ON wanted(portfolio);

  CREATE TABLE IF NOT EXISTS agent_last_seen (
    user_id INTEGER PRIMARY KEY,
    last_seen TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// ── Migrations — إضافة أعمدة جديدة لقواعد البيانات القديمة ──
try { db.exec(`ALTER TABLE users ADD COLUMN can_export_scans INTEGER NOT NULL DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE scans ADD COLUMN area TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE users ADD COLUMN can_export_wanted INTEGER NOT NULL DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE users ADD COLUMN can_voice_scan INTEGER DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE users ADD COLUMN can_manage_portfolios INTEGER DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE users ADD COLUMN can_check INTEGER DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE users ADD COLUMN can_use_web INTEGER DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE users ADD COLUMN email TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE users ADD COLUMN otp_enabled INTEGER DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE users ADD COLUMN device_lock INTEGER DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE users ADD COLUMN monthly_goal INTEGER DEFAULT 1000`); } catch(e) {}
try { db.exec(`ALTER TABLE scans ADD COLUMN wanted_company TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE scans ADD COLUMN wanted_model TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE scans ADD COLUMN wanted_portfolio TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE users ADD COLUMN group_name TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'agent'`); } catch(e) {}

// ── Indexes لتسريع الاستعلامات ─────────────────────────────────
try { db.exec('CREATE INDEX IF NOT EXISTS idx_scans_plate ON scans(plate)'); } catch(e) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_scans_user ON scans(user_id)'); } catch(e) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_scans_date ON scans(created_at)'); } catch(e) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_scans_wanted ON scans(is_wanted)'); } catch(e) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_wanted_plate ON wanted(plate)'); } catch(e) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_users_name ON users(username)'); } catch(e) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_users_group ON users(group_name)'); } catch(e) {}

// ── جدول سجل النشاط ──────────────────────────────────────────────
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      user_name TEXT,
      action TEXT NOT NULL,
      detail TEXT,
      group_name TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )`);
  } catch(e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at)'); } catch(e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_log(user_id)'); } catch(e) {}

// ── جدول بصمات/مفاتيح WebAuthn (نسخة الويب) ──────────────────────
try {
  db.exec(`CREATE TABLE IF NOT EXISTS webauthn_credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    credential_id TEXT UNIQUE NOT NULL,
    public_key TEXT NOT NULL,
    counter INTEGER DEFAULT 0,
    device_label TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);
} catch(e) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_webauthn_user ON webauthn_credentials(user_id)'); } catch(e) {}

// أضف مشرف افتراضي عند أول تشغيل
const adminExists = db.prepare("SELECT id FROM users WHERE username = 'admin'").get();
if (!adminExists) {
  const hash = crypto.createHash('sha256').update('admin123').digest('hex');
  db.prepare(`
    INSERT INTO users (username, password_hash, full_name, role)
    VALUES ('admin', ?, 'المشرف الرئيسي', 'admin')
  `).run(hash);
  console.log('✅ تم إنشاء حساب المشرف: admin / admin123');
}

// ── مساعدات ─────────────────────────────────────────────────────
// تحويل اللوحة لشكل مفصول: أبس1304 → أ ب س 1304
function spacedPlate(plate) {
  const letters = plate.replace(/[0-9]/g, '');
  const nums    = plate.replace(/[^0-9]/g, '');
  return [...letters].join(' ') + ' ' + nums;
}

function hashPassword(pass) {
  return crypto.createHash('sha256').update(pass).digest('hex');
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'غير مخوّل' });
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    // تحقق من وجود المستخدم في DB وأنه نشط
    const dbUser = db.prepare('SELECT id, is_active FROM users WHERE id = ?').get(req.user.id);
    if (!dbUser)        return res.status(401).json({ error: 'الحساب غير موجود، تواصل مع المشرف' });
    if (!dbUser.is_active) return res.status(401).json({ error: 'الحساب موقوف، تواصل مع المشرف' });
    next();
  } catch {
    res.status(401).json({ error: 'جلسة منتهية، سجّل دخولك مجدداً' });
  }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'للمشرفين فقط' });
  next();
}

// صلاحية إدارة المحافظ — admin أو من أعطاه admin الصلاحية
function portfolioManagerOnly(req, res, next) {
  const user = db.prepare('SELECT can_manage_portfolios, role FROM users WHERE id = ?').get(req.user.id);
  const isAdmin       = req.user.role === 'admin';
  const isGroupAdmin  = req.user.role === 'group_admin';
  const hasPermission = user?.can_manage_portfolios;
  if (!isAdmin && !isGroupAdmin && !hasPermission) {
    return res.status(403).json({ error: 'ليس لديك صلاحية إدارة المحافظ' });
  }
  next();
}

// مشرف المجموعة أو الأدمن العام
function groupAdminOnly(req, res, next) {
  if (req.user.role !== 'admin' && req.user.role !== 'group_admin') {
    return res.status(403).json({ error: 'هذه الصفحة لمشرفي المجموعات فقط' });
  }
  next();
}

// ── تسجيل الدخول ────────────────────────────────────────────────

// يبني ويرجّع التوكن + بيانات المستخدم (نفس الشكل دائماً — دخول مباشر أو بعد OTP)
function issueLoginResponse(res, user) {
  const token = jwt.sign(
    { id: user.id, username: user.username, full_name: user.full_name, role: user.role, group_name: user.group_name, can_export_scans: !!user.can_export_scans, can_export_wanted: !!user.can_export_wanted, can_voice_scan: !!user.can_voice_scan },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
  res.json({ token, user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role, group_name: user.group_name, can_export_scans: !!user.can_export_scans, can_export_wanted: !!user.can_export_wanted, can_voice_scan: !!user.can_voice_scan, can_manage_portfolios: !!user.can_manage_portfolios, can_check: !!user.can_check, can_use_web: !!user.can_use_web, monthly_goal: user.monthly_goal } });
}

// ── تسجيل الدخول ────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { username, password, device_id } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'أدخل اسم المستخدم وكلمة المرور' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || user.password_hash !== hashPassword(password)) {
    return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور خاطئة' });
  }
  if (!user.is_active) {
    return res.status(403).json({ error: 'الحساب موقوف، تواصل مع المشرف' });
  }

  // بوابة النسخة الويب — إذا الطلب جاي من agent.html (X-Client-Type: web)
  // لازم يكون عنده صلاحية can_use_web (أو أدمن)
  const isWebClient = req.headers['x-client-type'] === 'web';
  if (isWebClient && user.role !== 'admin' && !user.can_use_web) {
    return res.status(403).json({ error: 'ليس لديك صلاحية استخدام النسخة الويب. تواصل مع المشرف' });
  }

  // قفل الجهاز — يطبق على المناديب دائماً أو أي مستخدم مفعّل له device_lock
  const shouldLock = user.role === 'agent' || user.device_lock === 1;
  if (shouldLock && device_id) {
    if (user.device_id && user.device_id !== device_id) {
      return res.status(403).json({ error: 'هذا الحساب مسجل على جهاز آخر. تواصل مع المشرف' });
    }
    if (!user.device_id) {
      db.prepare('UPDATE users SET device_id = ? WHERE id = ?').run(device_id, user.id);
    }
  }

  // تحقق إضافي عبر الإيميل (OTP) — فقط لو مفعّل للمستخدم وعنده إيميل مسجّل
  if (user.otp_enabled && user.email) {
    try {
      const pendingToken = await createAndSendOtp(user);
      return res.json({ requires_otp: true, pending_token: pendingToken, email_hint: maskEmail(user.email) });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  issueLoginResponse(res, user);
});

// ── التحقق من رمز OTP وإكمال تسجيل الدخول ──────────────────────
app.post('/api/login/verify-otp', (req, res) => {
  const { pending_token, code } = req.body;
  if (!pending_token || !code) return res.status(400).json({ error: 'الرمز مطلوب' });

  const result = verifyOtp(pending_token, code);
  if (!result.ok) return res.status(401).json({ error: result.error });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.userId);
  if (!user) return res.status(404).json({ error: 'المستخدم غير موجود' });

  issueLoginResponse(res, user);
});

function maskEmail(email) {
  const [namePart, domain] = String(email).split('@');
  if (!domain) return email;
  const visible = namePart.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(namePart.length - 2, 1))}@${domain}`;
}

// ── نسيت كلمة المرور — إرسال رمز عبر الإيميل ───────────────────
app.post('/api/forgot-password', async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'أدخل اسم المستخدم' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());
  if (!user || !user.email) {
    return res.status(404).json({ error: 'ما فيه إيميل مسجّل لهذا الحساب. تواصل مع المشرف' });
  }

  try {
    const pendingToken = await createAndSendOtp(user);
    res.json({ pending_token: pendingToken, email_hint: maskEmail(user.email) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── تعيين كلمة مرور جديدة بعد التحقق من الرمز ──────────────────
app.post('/api/reset-password', (req, res) => {
  const { pending_token, code, new_password } = req.body;
  if (!pending_token || !code || !new_password) {
    return res.status(400).json({ error: 'كل الحقول مطلوبة' });
  }
  if (new_password.length < 6) {
    return res.status(400).json({ error: 'كلمة المرور لازم تكون 6 أحرف على الأقل' });
  }

  const result = verifyOtp(pending_token, code);
  if (!result.ok) return res.status(401).json({ error: result.error });

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(new_password), result.userId);
  res.json({ success: true });
});

// ── WebAuthn (بصمة/وجه) — نسخة الويب فقط ──────────────────────────

// حالة البصمة للمستخدم الحالي: عنده بصمة مسجّلة أو لا
app.get('/api/webauthn/status', authMiddleware, (req, res) => {
  const creds = db.prepare('SELECT id, device_label, created_at FROM webauthn_credentials WHERE user_id = ?').all(req.user.id);
  res.json({ registered: creds.length > 0, credentials: creds });
});

// خطوة 1: توليد خيارات تسجيل بصمة جديدة (المستخدم مسجّل دخوله بالفعل)
app.post('/api/webauthn/register-options', authMiddleware, async (req, res) => {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const existing = db.prepare('SELECT credential_id FROM webauthn_credentials WHERE user_id = ?').all(user.id);
    const { options, challengeKey } = await webauthn.getRegistrationOptions(user, existing);
    res.json({ options, challenge_key: challengeKey });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// خطوة 2: التحقق من التسجيل وحفظ البصمة
app.post('/api/webauthn/register-verify', authMiddleware, async (req, res) => {
  const { challenge_key, response, device_label } = req.body;
  if (!challenge_key || !response) return res.status(400).json({ error: 'بيانات ناقصة' });
  try {
    const result = await webauthn.verifyRegistration(challenge_key, response);
    if (result.userId !== req.user.id) return res.status(403).json({ error: 'غير مصرح' });
    db.prepare('INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter, device_label) VALUES (?,?,?,?,?)')
      .run(result.userId, result.credentialId, result.publicKey, result.counter, device_label || 'هذا المتصفح');
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// حذف بصمة (إيقاف الدخول بالبصمة)
app.delete('/api/webauthn/credentials', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM webauthn_credentials WHERE user_id = ?').run(req.user.id);
  res.json({ success: true });
});

// خطوة 1 لتسجيل الدخول: توليد تحدي مصادقة (بدون تسجيل دخول مسبق)
app.post('/api/webauthn/login-options', async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'أدخل اسم المستخدم' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());
  if (!user) return res.status(404).json({ error: 'مستخدم غير موجود' });
  const creds = db.prepare('SELECT * FROM webauthn_credentials WHERE user_id = ?').all(user.id);
  if (!creds.length) return res.status(404).json({ error: 'ما فيه بصمة مسجّلة لهذا الحساب بهذا المتصفح' });
  try {
    const { options, challengeKey } = await webauthn.getAuthenticationOptions(user.username, creds);
    res.json({ options, challenge_key: challengeKey });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// خطوة 2 لتسجيل الدخول: التحقق من البصمة وإصدار التوكن
app.post('/api/webauthn/login-verify', async (req, res) => {
  const { username, challenge_key, response } = req.body;
  if (!username || !challenge_key || !response) return res.status(400).json({ error: 'بيانات ناقصة' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());
  if (!user) return res.status(404).json({ error: 'مستخدم غير موجود' });
  if (!user.is_active) return res.status(403).json({ error: 'الحساب موقوف، تواصل مع المشرف' });
  if (user.role !== 'admin' && !user.can_use_web) {
    return res.status(403).json({ error: 'ليس لديك صلاحية استخدام النسخة الويب. تواصل مع المشرف' });
  }

  const credentialId = response.id;
  const stored = db.prepare('SELECT * FROM webauthn_credentials WHERE user_id = ? AND credential_id = ?').get(user.id, credentialId);
  if (!stored) return res.status(404).json({ error: 'بصمة غير معروفة' });

  try {
    const result = await webauthn.verifyAuthentication(challenge_key, response, stored);
    db.prepare('UPDATE webauthn_credentials SET counter = ? WHERE id = ?').run(result.newCounter, stored.id);
    issueLoginResponse(res, user);
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});



// ── تشييك سريع — فحص بدون تسجيل ────────────────────────────────
app.post('/api/check', authMiddleware, (req, res) => {
  const { plate } = req.body;
  if (!plate) return res.status(400).json({ error: 'رقم اللوحة مطلوب' });

  // التحقق من الصلاحية
  const u = db.prepare('SELECT can_check, role FROM users WHERE id = ?').get(req.user.id);
  if (u.role !== 'admin' && !u.can_check) {
    return res.status(403).json({ error: 'ليس لديك صلاحية التشييك السريع' });
  }

  const cleanPlate = plate.toUpperCase().replace(/\s/g, '');
  const wanted = db.prepare('SELECT * FROM wanted WHERE plate = ?').get(cleanPlate);

  if (wanted) {
    return res.json({
      found: true,
      plate: cleanPlate,
      company:   wanted.company   || null,
      model:     wanted.model     || null,
      reason:    wanted.reason    || null,
      portfolio: wanted.portfolio || null,
    });
  }

  return res.json({ found: false, plate: cleanPlate });
});

// ── تسجيل لوحة (المندوب) ────────────────────────────────────────
app.post('/api/scans', authMiddleware, (req, res) => {
  const { plate, lat, lng, note } = req.body;
  if (!plate || lat == null || lng == null) return res.status(400).json({ error: 'رقم اللوحة والموقع مطلوبان' });

  // تحقق من المركبات المطلوبة
  const wanted = db.prepare('SELECT * FROM wanted WHERE plate = ?').get(plate.toUpperCase());

  const cleanPlate = plate.toUpperCase();
  const result = db.prepare(`
    INSERT INTO scans (plate, plate_spaced, lat, lng, note, user_id, user_name, group_name,
                       is_wanted, wanted_company, wanted_model, wanted_portfolio)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    cleanPlate, spacedPlate(cleanPlate),
    lat, lng, note || null,
    req.user.id, req.user.full_name, req.user.group_name,
    wanted ? 1 : 0,
    wanted?.company || null,
    wanted?.model   || null,
    wanted?.portfolio || null
  );

  res.json({
    id: result.lastInsertRowid,
    plate: cleanPlate,
    plate_spaced: spacedPlate(cleanPlate),
    is_wanted: !!wanted,
    wanted_details: wanted ? {
      reason:    wanted.reason    || null,
      company:   wanted.company   || null,
      model:     wanted.model     || null,
      portfolio: wanted.portfolio || null,
    } : null,
    message: wanted ? `⚠️ مركبة مطلوبة! ${wanted.company || ''} ${wanted.model || ''}` : 'تم التسجيل بنجاح'
  });
});

// ── سجلاتي (المندوب) ────────────────────────────────────────────
app.get('/api/scans/mine', authMiddleware, (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit) || 50, 2000);
  const hoursRaw = parseInt(req.query.hours);
  const hours  = (!isNaN(hoursRaw) && hoursRaw > 0 && hoursRaw <= 720) ? hoursRaw : null;
  const filter = hours
    ? `AND s.created_at >= datetime('now', '-${hours} hours')`
    : '';

  const scans = db.prepare(`
    SELECT s.*, w.reason as w_reason, w.company as w_company,
           w.model as w_model, w.portfolio as w_portfolio
    FROM scans s
    LEFT JOIN wanted w ON s.plate = w.plate
    WHERE s.user_id = ? ${filter}
    ORDER BY s.created_at DESC LIMIT ?
  `).all(req.user.id, limit);

  const result = scans.map(s => ({
    ...s,
    is_wanted: !!s.is_wanted,
    plate_spaced: s.plate_spaced || s.plate,
    wanted_details: s.is_wanted ? {
      reason: s.wanted_company ? null : s.w_reason,
      company: s.wanted_company || s.w_company,
      model: s.wanted_model || s.w_model,
      portfolio: s.wanted_portfolio || s.w_portfolio,
    } : null,
  }));
  res.json(result);
});

// ── لوحة التحكم: كل السجلات ─────────────────────────────────────
app.get('/api/admin/scans', authMiddleware, adminOnly, (req, res) => {
  const { from, to, user_id, agent, plate, wanted_only, limit = 5000 } = req.query;

  let query = `
    SELECT s.*,
           s.plate_spaced,
           w.company as w_company, w.model as w_model, w.portfolio as w_portfolio, w.reason as w_reason
    FROM scans s
    LEFT JOIN wanted w ON s.plate = w.plate
    WHERE 1=1
  `;
  const params = [];

  if (from)        { query += ' AND date(s.created_at) >= ?'; params.push(from); }
  if (to)          { query += ' AND date(s.created_at) <= ?'; params.push(to); }
  if (user_id)     { query += ' AND s.user_id = ?'; params.push(user_id); }
  if (plate)       { query += ' AND (s.plate LIKE ? OR s.plate_spaced LIKE ?)'; params.push(`%${plate}%`, `%${plate}%`); }
  if (agent)       { query += ' AND s.user_name LIKE ?'; params.push(`%${agent}%`); }
  if (wanted_only === '1') { query += ' AND s.is_wanted = 1'; }

  query += ' ORDER BY s.created_at DESC LIMIT ?';
  params.push(parseInt(limit));

  const rows = db.prepare(query).all(...params);
  const result = rows.map(s => ({
    ...s,
    plate_spaced: s.plate_spaced || s.plate,
    wanted_company:   s.wanted_company   || s.w_company,
    wanted_model:     s.wanted_model     || s.w_model,
    wanted_portfolio: s.wanted_portfolio || s.w_portfolio,
    wanted_reason:    s.w_reason,
  }));
  res.json(result);
});

// ── استرجاع سجلات قديمة من ملف Excel مصدّر سابقاً (بعد فقد بيانات مثلاً) ──
app.post('/api/admin/scans/import', authMiddleware, adminOnly,
  multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } }).single('file'),
  (req, res) => {
    const targetUserId = parseInt(req.body.target_user_id);
    if (!targetUserId) return res.status(400).json({ error: 'اختر المندوب اللي راح نستورد له السجلات' });
    if (!req.file) return res.status(400).json({ error: 'ارفع ملف Excel' });

    const targetUser = db.prepare('SELECT * FROM users WHERE id = ?').get(targetUserId);
    if (!targetUser) return res.status(404).json({ error: 'المستخدم غير موجود' });

    let rows;
    try {
      const XLSX = require('xlsx');
      const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
      rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
    } catch (err) {
      return res.status(400).json({ error: 'تعذر قراءة الملف: ' + err.message });
    }

    const insertStmt = db.prepare(`
      INSERT INTO scans (plate, plate_spaced, lat, lng, note, is_wanted, wanted_company, wanted_model, wanted_portfolio, user_id, user_name, group_name, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    const dupCheck = db.prepare('SELECT id FROM scans WHERE user_id = ? AND plate = ? AND created_at = ?');

    let imported = 0, skipped = 0, errors = 0;

    for (const row of rows) {
      try {
        const rawPlate = String(row.plate || row['plate_spaced'] || '').trim();
        if (!rawPlate) continue;
        const normalized = normalizePlate(rawPlate.replace(/\s+/g, ''));
        if (!normalized || !/\d/.test(normalized)) { errors++; continue; }

        const createdAt = row.created_at || row['تاريخ'] || null;
        if (!createdAt) { errors++; continue; }

        // تفادي استيراد نفس السجل مرتين لو رفع الملف أكثر من مرة
        const exists = dupCheck.get(targetUserId, normalized, createdAt);
        if (exists) { skipped++; continue; }

        const isWanted = ['نعم', 'yes', 'true', '1', 1, true].includes(row.is_wanted) ? 1 : 0;

        insertStmt.run(
          normalized,
          row.plate_spaced || spacedPlate(normalized),
          parseFloat(row.lat) || 0,
          parseFloat(row.lng) || 0,
          row.note || null,
          isWanted,
          row.wanted_company || null,
          row.wanted_model || null,
          row.wanted_portfolio || null,
          targetUserId,
          targetUser.full_name || targetUser.username,
          targetUser.group_name || null,
          createdAt
        );
        imported++;
      } catch (err) {
        errors++;
      }
    }

    logActivity(req.user.id, req.user.full_name || req.user.username, 'import_scans',
      `استيراد سجلات قديمة لـ ${targetUser.full_name} (${imported} سجل)`, req.user.group_name);

    res.json({ imported, skipped, errors, total_rows: rows.length });
  }
);

// ── لوحة التحكم: إحصائيات ───────────────────────────────────────
app.get('/api/admin/stats', authMiddleware, adminOnly, (req, res) => {
  const totalScans   = db.prepare('SELECT COUNT(*) as n FROM scans').get().n;
  const todayScans   = db.prepare("SELECT COUNT(*) as n FROM scans WHERE date(created_at) = date('now')").get().n;
  const totalAgents  = db.prepare("SELECT COUNT(*) as n FROM users WHERE role = 'agent'").get().n;
  const totalWanted  = db.prepare('SELECT COUNT(*) as n FROM wanted').get().n;
  const topAgents    = db.prepare(`
    SELECT user_name, COUNT(*) as count FROM scans
    GROUP BY user_id ORDER BY count DESC LIMIT 5
  `).all();
  const recentScans  = db.prepare('SELECT * FROM scans ORDER BY created_at DESC LIMIT 10').all();

  res.json({ totalScans, todayScans, totalAgents, totalWanted, topAgents, recentScans });
});

// ── إدارة المستخدمين ─────────────────────────────────────────────
app.get('/api/admin/users', authMiddleware, adminOnly, (req, res) => {
  const users = db.prepare(`
    SELECT id, username, full_name, role, group_name, is_active, device_id,
           can_export_scans, can_export_wanted, can_voice_scan,
           can_manage_portfolios, can_check, can_use_web, email, otp_enabled, device_lock, created_at
    FROM users
    ORDER BY CASE WHEN role='admin' THEN 0 ELSE 1 END, created_at ASC
  `).all();
  res.json(users);
});

app.post('/api/admin/users', authMiddleware, adminOnly, (req, res) => {
  const { username, password, full_name, role = 'agent', group_name } = req.body;
  if (!username || !password || !full_name) return res.status(400).json({ error: 'البيانات ناقصة' });
  try {
    db.prepare(`
      INSERT INTO users (username, password_hash, full_name, role, group_name)
      VALUES (?, ?, ?, ?, ?)
    `).run(username, hashPassword(password), full_name, role, group_name || null);
    res.json({ success: true, message: 'تم إنشاء الحساب' });
  } catch {
    res.status(400).json({ error: 'اسم المستخدم موجود مسبقاً' });
  }
});

app.patch('/api/admin/users/:id', authMiddleware, adminOnly, (req, res) => {
  const { is_active, device_id, password, can_export_scans, can_export_wanted, can_voice_scan, can_manage_portfolios, can_check, can_use_web, email, otp_enabled, device_lock, role, group_name, full_name } = req.body;
  const { id } = req.params;
  if (is_active !== undefined)         db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(is_active ? 1 : 0, id);
  if (device_id === null)              db.prepare('UPDATE users SET device_id = NULL WHERE id = ?').run(id);
  if (password)                        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), id);
  if (can_export_scans !== undefined)  db.prepare('UPDATE users SET can_export_scans = ? WHERE id = ?').run(can_export_scans ? 1 : 0, id);
  if (can_export_wanted !== undefined) db.prepare('UPDATE users SET can_export_wanted = ? WHERE id = ?').run(can_export_wanted ? 1 : 0, id);
  if (can_voice_scan !== undefined) db.prepare('UPDATE users SET can_voice_scan = ? WHERE id = ?').run(can_voice_scan ? 1 : 0, id);
  if (can_manage_portfolios !== undefined) db.prepare('UPDATE users SET can_manage_portfolios = ? WHERE id = ?').run(can_manage_portfolios ? 1 : 0, id);
  if (can_check !== undefined) db.prepare('UPDATE users SET can_check = ? WHERE id = ?').run(can_check ? 1 : 0, id);
  if (can_use_web !== undefined) db.prepare('UPDATE users SET can_use_web = ? WHERE id = ?').run(can_use_web ? 1 : 0, id);
  if (email !== undefined) db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, id);
  if (otp_enabled !== undefined) db.prepare('UPDATE users SET otp_enabled = ? WHERE id = ?').run(otp_enabled ? 1 : 0, id);
  if (device_lock !== undefined) db.prepare('UPDATE users SET device_lock = ? WHERE id = ?').run(device_lock ? 1 : 0, id);
  if (full_name)                       db.prepare('UPDATE users SET full_name = ? WHERE id = ?').run(full_name, id);
  if (group_name !== undefined)        db.prepare('UPDATE users SET group_name = ? WHERE id = ?').run(group_name || null, id);
  if (role && ['agent','group_admin'].includes(role)) {
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  }
  res.json({ success: true });
});

// حذف مستخدم نهائياً (مندوب أو مشرف مجموعة) — admin فقط
app.delete('/api/admin/users/:id', authMiddleware, adminOnly, (req, res) => {
  const { id } = req.params;
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'المستخدم غير موجود' });
  if (target.role === 'admin') return res.status(403).json({ error: 'لا يمكن حذف حساب المشرف العام' });

  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ success: true, message: 'تم حذف الحساب نهائياً' });
});

// ── إدارة المركبات المطلوبة ──────────────────────────────────────
app.get('/api/admin/wanted', authMiddleware, adminOnly, (req, res) => {
  res.json(db.prepare('SELECT * FROM wanted ORDER BY created_at DESC').all());
});

app.post('/api/admin/wanted', authMiddleware, adminOnly, (req, res) => {
  const { plate, reason, company, model } = req.body;
  if (!plate) return res.status(400).json({ error: 'رقم اللوحة مطلوب' });
  try {
    db.prepare('INSERT INTO wanted (plate, reason, company, model, added_by) VALUES (?, ?, ?, ?, ?)').run(
      plate.toUpperCase(), reason || null, company || null, model || null, req.user.full_name
    );
    res.json({ success: true });
  } catch {
    res.status(400).json({ error: 'اللوحة موجودة مسبقاً' });
  }
});

app.delete('/api/admin/wanted/:id', authMiddleware, adminOnly, (req, res) => {
  db.prepare('DELETE FROM wanted WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});


// ── فحص إصدار التطبيق ──────────────────────────────────────────
// غيّر APP_VERSION عند إصدار تحديث جديد يحتاج التطبيق أن يُحدَّث
const MIN_APP_VERSION = '2.0.0';

app.get('/api/version', (req, res) => {
  res.json({
    min_version: MIN_APP_VERSION,
    current_version: MIN_APP_VERSION,
    update_required: false,
    update_message: 'يرجى تحديث التطبيق للاستمرار',
  });
});



// ════════════════════════════════════════════════════════════════
// ── مشرف المجموعة ──────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════

// نظرة عامة على المجموعة — إحصائيات شاملة
app.get('/api/group/overview', authMiddleware, groupAdminOnly, (req, res) => {
  const groupName = req.user.role === 'admin' ? req.query.group : req.user.group_name;
  if (!groupName) return res.status(400).json({ error: 'حدد اسم المجموعة' });

  // كل مناديب هذه المجموعة (فقط agent، ليس group_admin آخر)
  const agents = db.prepare(`
    SELECT id, username, full_name, is_active, device_id, monthly_goal
    FROM users WHERE group_name = ? AND role = 'agent'
  `).all(groupName);

  const agentIds = agents.map(a => a.id);
  if (agentIds.length === 0) {
    return res.json({ agents: [], stats: { today:0, week:0, month:0, total:0, active_now:0 } });
  }

  const placeholders = agentIds.map(() => '?').join(',');

  // إحصائيات لكل فترة
  const todayCount = db.prepare(`SELECT COUNT(*) as c FROM scans WHERE user_id IN (${placeholders}) AND date(created_at)=date('now')`).get(...agentIds).c;
  const weekCount  = db.prepare(`SELECT COUNT(*) as c FROM scans WHERE user_id IN (${placeholders}) AND created_at >= datetime('now','-7 days')`).get(...agentIds).c;
  const monthCount = db.prepare(`SELECT COUNT(*) as c FROM scans WHERE user_id IN (${placeholders}) AND created_at >= datetime('now','-30 days')`).get(...agentIds).c;
  const totalCount = db.prepare(`SELECT COUNT(*) as c FROM scans WHERE user_id IN (${placeholders})`).get(...agentIds).c;

  // نشط الآن = سجّل خلال آخر 15 دقيقة
  const activeNow = db.prepare(`
    SELECT COUNT(DISTINCT user_id) as c FROM scans
    WHERE user_id IN (${placeholders}) AND created_at >= datetime('now','-15 minutes')
  `).get(...agentIds).c;

  // تفاصيل كل مندوب
  const agentDetails = agents.map(a => {
    const lastScan = db.prepare(`
      SELECT plate, lat, lng, created_at FROM scans
      WHERE user_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(a.id);

    const todayAgentCount = db.prepare(`
      SELECT COUNT(*) as c FROM scans WHERE user_id = ? AND date(created_at)=date('now')
    `).get(a.id).c;

    const monthAgentCount = db.prepare(`
      SELECT COUNT(*) as c FROM scans WHERE user_id = ? AND created_at >= datetime('now','-30 days')
    `).get(a.id).c;

    const totalAgentCount = db.prepare(`
      SELECT COUNT(*) as c FROM scans WHERE user_id = ?
    `).get(a.id).c;

    const isActive = lastScan && lastScan.created_at >= new Date(Date.now() - 15*60*1000).toISOString();
    const isStopped = lastScan && lastScan.created_at < new Date(Date.now() - 30*60*1000).toISOString();
    const minutesAgo = lastScan ? Math.floor((Date.now() - new Date(lastScan.created_at).getTime()) / 60000) : null;

    // أول سجل اليوم لحساب مدة العمل
    const firstToday = db.prepare(`
      SELECT created_at FROM scans WHERE user_id = ? AND date(created_at)=date('now') ORDER BY created_at ASC LIMIT 1
    `).get(a.id);
    let workMinutes = 0;
    if (firstToday && lastScan) {
      workMinutes = Math.floor((new Date(lastScan.created_at) - new Date(firstToday.created_at)) / 60000);
    }

    return {
      id: a.id,
      full_name: a.full_name,
      username: a.username,
      is_active: isActive,
      is_stopped: isStopped,
      minutes_since_last: minutesAgo,
      last_plate: lastScan?.plate || null,
      last_lat: lastScan?.lat || null,
      last_lng: lastScan?.lng || null,
      today_count: todayAgentCount,
      month_count: monthAgentCount,
      total_count: totalAgentCount,
      work_minutes_today: workMinutes,
      monthly_goal: a.monthly_goal || 1000,
    };
  });

  // ترتيب حسب أداء اليوم
  agentDetails.sort((a,b) => b.today_count - a.today_count);

  // هدف المجموعة = مجموع أهداف المناديب (أو هدف موحد)
  const groupGoal = agents.reduce((sum,a) => sum + (a.monthly_goal || 1000), 0);

  res.json({
    agents: agentDetails,
    stats: {
      today: todayCount,
      week: weekCount,
      month: monthCount,
      total: totalCount,
      active_now: activeNow,
      total_agents: agents.length,
      avg_daily: agents.length ? Math.round(weekCount/7) : 0,
      avg_weekly: weekCount,
      avg_monthly: monthCount,
      monthly_goal: groupGoal,
      goal_progress: groupGoal ? Math.round((monthCount/groupGoal)*100) : 0,
    },
  });
});

// رسم بياني — أداء مندوب آخر 7 أيام
app.get('/api/group/agent-chart/:id', authMiddleware, groupAdminOnly, (req, res) => {
  const agentId = req.params.id;
  // تحقق أن هذا المندوب في نفس مجموعة المشرف
  if (req.user.role !== 'admin') {
    const agent = db.prepare('SELECT group_name FROM users WHERE id = ?').get(agentId);
    if (!agent || agent.group_name !== req.user.group_name) {
      return res.status(403).json({ error: 'هذا المندوب ليس في مجموعتك' });
    }
  }

  const days = [];
  for (let i = 6; i >= 0; i--) {
    const day = db.prepare(`
      SELECT COUNT(*) as c FROM scans
      WHERE user_id = ? AND date(created_at) = date('now', '-${i} days')
    `).get(agentId).c;
    days.push(day);
  }
  res.json({ days });
});

// مطلوبات المجموعة كاملة — كل اللوحات التي رصدها أي مندوب في المجموعة
app.get('/api/group/wanted', authMiddleware, groupAdminOnly, (req, res) => {
  const groupName = req.user.role === 'admin' ? req.query.group : req.user.group_name;
  if (!groupName) return res.status(400).json({ error: 'حدد اسم المجموعة' });

  const agents = db.prepare(`SELECT id, full_name FROM users WHERE group_name = ? AND role = 'agent'`).all(groupName);
  const agentIds = agents.map(a => a.id);
  if (agentIds.length === 0) return res.json([]);

  const placeholders = agentIds.map(() => '?').join(',');
  const nameMap = {};
  agents.forEach(a => nameMap[a.id] = a.full_name);

  const rows = db.prepare(`
    SELECT s.plate, s.user_id, s.lat, s.lng, s.note, s.created_at,
           w.company, w.model, w.portfolio, w.reason
    FROM scans s
    INNER JOIN wanted w ON s.plate = w.plate
    WHERE s.user_id IN (${placeholders})
    ORDER BY s.created_at DESC
  `).all(...agentIds);

  // تجميع — آخر رصد لكل لوحة
  const seen = new Set();
  const result = [];
  for (const r of rows) {
    if (seen.has(r.plate)) continue;
    seen.add(r.plate);
    result.push({
      plate: r.plate,
      agent_name: nameMap[r.user_id] || '',
      lat: r.lat, lng: r.lng,
      map_link: `https://maps.google.com/?q=${r.lat},${r.lng}`,
      note: r.note,
      company: r.company, model: r.model, portfolio: r.portfolio, reason: r.reason,
      created_at: r.created_at,
    });
  }
  res.json(result);
});

// تصدير سجلات المجموعة — مع اسم المندوب وكل البيانات
app.get('/api/group/export-scans', authMiddleware, groupAdminOnly, (req, res) => {
  const groupName = req.user.role === 'admin' ? req.query.group : req.user.group_name;
  if (!groupName) return res.status(400).json({ error: 'حدد اسم المجموعة' });
  const todayOnly = req.query.today === '1';

  // جلب مناديب المجموعة + المشرف نفسه دائماً
  const agents = db.prepare(`SELECT id, full_name FROM users WHERE group_name = ? AND role IN ('agent','group_admin')`).all(groupName);
  const agentIds = [...new Set([req.user.id, ...agents.map(a => a.id)])];
  if (agentIds.length === 0) return res.json([]);

  const placeholders = agentIds.map(() => '?').join(',');
  const filter = todayOnly ? `AND date(s.created_at,'localtime') = date('now','localtime')` : '';

  const scans = db.prepare(`
    SELECT s.plate, s.plate_spaced, s.lat, s.lng, s.note,
           s.is_wanted, s.user_name, s.group_name, s.created_at,
           s.wanted_company, s.wanted_model, s.wanted_portfolio,
           w.company as w_company, w.model as w_model,
           w.portfolio as w_portfolio, w.reason as w_reason
    FROM scans s
    LEFT JOIN wanted w ON s.plate = w.plate
    WHERE s.user_id IN (${placeholders}) ${filter}
    ORDER BY s.user_name ASC, s.created_at DESC
    LIMIT 10000
  `).all(...agentIds);

  res.json(scans.map(s => ({
    المندوب: s.user_name || '',
    المجموعة: s.group_name || groupName,
    اللوحة: s.plate,
    'اللوحة مفصولة': s.plate_spaced || s.plate,
    مطلوبة: s.is_wanted ? 'نعم' : 'لا',
    الجهة: s.wanted_company || s.w_company || '',
    الموديل: s.wanted_model || s.w_model || '',
    المحفظة: s.wanted_portfolio || s.w_portfolio || '',
    السبب: s.w_reason || '',
    الملاحظة: s.note || '',
    'خط العرض': s.lat || '',
    'خط الطول': s.lng || '',
    'رابط الموقع': s.lat && s.lng ? `https://maps.google.com/?q=${s.lat},${s.lng}` : '',
    التاريخ: s.created_at || '',
  })));
  logActivity(req.user.id, req.user.full_name||req.user.username, 'export_group',
    `سحب بيانات المجموعة`, req.user.group_name);
});

// تعديل الهدف الشهري (مشرف المجموعة لنفسه أو admin لأي أحد)
app.patch('/api/group/goal', authMiddleware, groupAdminOnly, (req, res) => {
  const { agent_id, monthly_goal } = req.body;
  if (!monthly_goal || monthly_goal < 1) return res.status(400).json({ error: 'هدف غير صالح' });

  if (req.user.role !== 'admin') {
    // تحقق أن المندوب في نفس مجموعة المشرف
    const agent = db.prepare('SELECT group_name FROM users WHERE id = ?').get(agent_id);
    if (!agent || agent.group_name !== req.user.group_name) {
      return res.status(403).json({ error: 'هذا المندوب ليس في مجموعتك' });
    }
  }

  db.prepare('UPDATE users SET monthly_goal = ? WHERE id = ?').run(monthly_goal, agent_id);
  res.json({ success: true });
});


// ── محافظ — صاحب الصلاحية (يُعطيه admin) ──────────────────────
// جلب قائمة المحافظ
// ── آخر تحديث المحافظ — لكل المستخدمين ──────────────────────────
app.get('/api/portfolios/last-update', authMiddleware, (req, res) => {
  const rows = db.prepare(`
    SELECT name, updated_at, updated_by, total_plates
    FROM portfolios
    ORDER BY updated_at DESC
    LIMIT 10
  `).all();
  res.json(rows);
});

app.get('/api/portfolios', authMiddleware, portfolioManagerOnly, (req, res) => {
  const rows = db.prepare(`
    SELECT portfolio, COUNT(*) as count,
           MAX(last_portfolio_update) as last_update
    FROM wanted GROUP BY portfolio ORDER BY portfolio
  `).all();
  res.json(rows);
});

// دالة قراءة Excel للمحافظ
async function parsePortfolioExcel(buffer, portfolioName) {
  // نستخدم نفس معالج Admin القوي
  const name = portfolioName || 'محفظة جديدة';
  const result = processExcelBuffer(buffer, name);
  const rows = (result.plates || []).map(p => ({ plate: p.plate }));
  return { portfolioName: name, rows };
}

// رفع محفظة جديدة (preview) — يستخدم نفس multer
app.post('/api/portfolios/upload', authMiddleware, portfolioManagerOnly,
  multer({ storage: multer.memoryStorage() }).single('file'),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'لم يتم إرفاق ملف' });
      const { portfolioName, rows } = await parsePortfolioExcel(req.file.buffer, req.body.portfolioName);
      res.json({ portfolio: portfolioName, count: rows.length, preview: rows.slice(0, 5), rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

// تأكيد رفع المحفظة
// mode: 'replace' = استبدال كامل (للبنوك)
// mode: 'dedup'   = إزالة مكررات فقط من المحافظ الأخرى (للمجمّعة)
app.post('/api/portfolios/confirm', authMiddleware, portfolioManagerOnly, (req, res) => {
  const { portfolio, rows, mode = 'replace' } = req.body;
  if (!portfolio || !rows?.length) return res.status(400).json({ error: 'بيانات ناقصة' });

  const now = new Date().toISOString();

  const updatePortfolio = db.transaction((items) => {
    if (mode === 'replace') {
      // استبدال كامل — احذف القديمة وضع الجديدة
      db.prepare('DELETE FROM wanted WHERE portfolio = ?').run(portfolio);
    }
    // append — لا تحذف شيئاً، فقط أضف الجديد
    // dedup — لا تحذف القديمة، فقط أزل المكررات من المحافظ الأخرى

    const insert = db.prepare(`
      INSERT INTO wanted (plate, portfolio, last_portfolio_update)
      VALUES (?, ?, ?)
      ON CONFLICT(plate) DO UPDATE SET
        portfolio = excluded.portfolio,
        last_portfolio_update = excluded.last_portfolio_update
    `);

    let added = 0, duplicates = 0;
    for (const row of items) {
      if (row.plate) {
        const plate = row.plate.toUpperCase().trim();
        if (!plate) continue;
        // تحقق إذا كانت موجودة في محفظة أخرى
        const existing = db.prepare('SELECT portfolio FROM wanted WHERE plate = ?').get(plate);
        if (existing && existing.portfolio !== portfolio) duplicates++;
        insert.run(plate, portfolio, now);
        added++;
      }
    }
    return { added, duplicates };
  });

  const result = updatePortfolio(rows);

  // تحديث جدول portfolios بالتاريخ والمُحدِّث
  try {
    db.prepare(`
      INSERT INTO portfolios (name, total_plates, updated_by, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(name) DO UPDATE SET
        total_plates = excluded.total_plates,
        updated_by   = excluded.updated_by,
        updated_at   = datetime('now')
    `).run(portfolio, result.added, req.user.full_name || req.user.username || 'مجهول');
  } catch(e) {}

  logActivity(req.user.id, req.user.full_name||req.user.username, 'upload_portfolio',
    `رفع محفظة ${portfolio} (${result.added} لوحة)`, req.user.group_name);
  res.json({ success: true, ...result, portfolio, mode });
});

// حذف محفظة
app.delete('/api/portfolios/:name', authMiddleware, portfolioManagerOnly, (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const result = db.prepare('DELETE FROM wanted WHERE portfolio = ?').run(name);
  res.json({ success: true, deleted: result.changes });
});


// إحصائيات المندوب الشخصية
app.get('/api/scans/my-stats', authMiddleware, (req, res) => {
  const uid = req.user.id;
  const today = new Date().toLocaleDateString('en-CA', {timeZone:'Asia/Riyadh'});
  const weekAgo  = new Date(Date.now() - 7*86400000).toISOString();
  const monthAgo = new Date(Date.now() - 30*86400000).toISOString();

  const todayCount  = db.prepare(`SELECT COUNT(*) as c FROM scans WHERE user_id=? AND date(created_at,'localtime')=?`).get(uid, today).c;
  const weekCount   = db.prepare(`SELECT COUNT(*) as c FROM scans WHERE user_id=? AND created_at>=?`).get(uid, weekAgo).c;
  const monthCount  = db.prepare(`SELECT COUNT(*) as c FROM scans WHERE user_id=? AND created_at>=?`).get(uid, monthAgo).c;
  const totalCount  = db.prepare(`SELECT COUNT(*) as c FROM scans WHERE user_id=?`).get(uid).c;
  const wantedCount = db.prepare(`SELECT COUNT(*) as c FROM scans WHERE user_id=? AND is_wanted=1`).get(uid).c;

  // أول وآخر تسجيل اليوم
  const firstToday = db.prepare(`SELECT created_at FROM scans WHERE user_id=? AND date(created_at,'localtime')=? ORDER BY created_at ASC LIMIT 1`).get(uid, today);
  const lastToday  = db.prepare(`SELECT created_at FROM scans WHERE user_id=? AND date(created_at,'localtime')=? ORDER BY created_at DESC LIMIT 1`).get(uid, today);
  let workMinutes = 0;
  if (firstToday && lastToday && firstToday.created_at !== lastToday.created_at) {
    workMinutes = Math.floor((new Date(lastToday.created_at) - new Date(firstToday.created_at)) / 60000);
  }

  // أفضل يوم
  const bestDay = db.prepare(`
    SELECT date(created_at,'localtime') as day, COUNT(*) as c
    FROM scans WHERE user_id=? GROUP BY day ORDER BY c DESC LIMIT 1
  `).get(uid);

  // آخر 7 أيام
  const last7 = [];
  for (let i=6; i>=0; i--) {
    const d = new Date(Date.now() - i*86400000);
    const ds = d.toLocaleDateString('en-CA', {timeZone:'Asia/Riyadh'});
    const c = db.prepare(`SELECT COUNT(*) as c FROM scans WHERE user_id=? AND date(created_at,'localtime')=?`).get(uid, ds).c;
    last7.push({ day: d.toLocaleDateString('ar-SA',{timeZone:'Asia/Riyadh',weekday:'short'}), count: c });
  }

  res.json({
    today: todayCount, week: weekCount, month: monthCount, total: totalCount,
    wanted_count: wantedCount,
    wanted_rate: totalCount > 0 ? ((wantedCount/totalCount)*100).toFixed(1) : '0',
    work_minutes: workMinutes,
    best_day: bestDay?.day || null,
    best_day_count: bestDay?.c || 0,
    last7,
  });
});

// إحصائيات مقارنة مناديب المجموعة
app.get('/api/group/agents-stats', authMiddleware, groupAdminOnly, (req, res) => {
  const groupName = req.user.role === 'admin' ? req.query.group : req.user.group_name;
  if (!groupName) return res.status(400).json({ error: 'حدد اسم المجموعة' });

  const agents = db.prepare(`SELECT id, full_name, monthly_goal FROM users WHERE group_name = ? AND role = 'agent'`).all(groupName);

  const stats = agents.map(a => {
    const today = new Date().toLocaleDateString('en-CA', {timeZone:'Asia/Riyadh'});
    const weekAgo = new Date(Date.now() - 7*86400000).toISOString();
    const monthAgo = new Date(Date.now() - 30*86400000).toISOString();

    const todayCount  = db.prepare(`SELECT COUNT(*) as c FROM scans WHERE user_id=? AND date(created_at,'localtime')=?`).get(a.id, today).c;
    const weekCount   = db.prepare(`SELECT COUNT(*) as c FROM scans WHERE user_id=? AND created_at>=?`).get(a.id, weekAgo).c;
    const monthCount  = db.prepare(`SELECT COUNT(*) as c FROM scans WHERE user_id=? AND created_at>=?`).get(a.id, monthAgo).c;
    const totalCount  = db.prepare(`SELECT COUNT(*) as c FROM scans WHERE user_id=?`).get(a.id).c;
    const wantedCount = db.prepare(`SELECT COUNT(*) as c FROM scans WHERE user_id=? AND is_wanted=1`).get(a.id).c;

    // مدة العمل اليوم
    const firstToday = db.prepare(`SELECT created_at FROM scans WHERE user_id=? AND date(created_at,'localtime')=? ORDER BY created_at ASC LIMIT 1`).get(a.id, today);
    const lastToday  = db.prepare(`SELECT created_at FROM scans WHERE user_id=? AND date(created_at,'localtime')=? ORDER BY created_at DESC LIMIT 1`).get(a.id, today);
    let workMinutes = 0;
    if (firstToday && lastToday && firstToday.created_at !== lastToday.created_at) {
      workMinutes = Math.floor((new Date(lastToday.created_at) - new Date(firstToday.created_at)) / 60000);
    }

    // آخر 7 أيام
    const last7 = [];
    for (let i=6; i>=0; i--) {
      const d = new Date(Date.now() - i*86400000);
      const ds = d.toLocaleDateString('en-CA', {timeZone:'Asia/Riyadh'});
      const dayName = d.toLocaleDateString('ar-SA', {timeZone:'Asia/Riyadh', weekday:'short'});
      const c = db.prepare(`SELECT COUNT(*) as c FROM scans WHERE user_id=? AND date(created_at,'localtime')=?`).get(a.id, ds).c;
      last7.push({day: dayName, count: c});
    }

    const activeDays = db.prepare(`SELECT COUNT(DISTINCT date(created_at,'localtime')) as c FROM scans WHERE user_id=? AND created_at>=?`).get(a.id, monthAgo).c;
    const avgDaily = activeDays > 0 ? Math.round(monthCount / activeDays) : 0;
    const goalProgress = a.monthly_goal > 0 ? Math.round((monthCount / a.monthly_goal) * 100) : 0;

    return {
      id: a.id,
      full_name: a.full_name,
      today: todayCount,
      week: weekCount,
      month: monthCount,
      total: totalCount,
      wanted_count: wantedCount,
      wanted_rate: totalCount > 0 ? ((wantedCount/totalCount)*100).toFixed(1) : '0',
      work_minutes: workMinutes,
      avg_daily: avgDaily,
      active_days: activeDays,
      monthly_goal: a.monthly_goal || 1000,
      goal_progress: goalProgress,
      last7,
    };
  });

  // ترتيب حسب الإنتاج اليوم
  stats.sort((a,b) => b.today - a.today);
  res.json(stats);
});

// ── Keep-alive لمنع Railway من النوم ──────────────────────────
app.get('/ping', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ── تصدير متقدم (Excel) — للأدمن ────────────────────────────────
app.get('/api/admin/export-advanced', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { agents, dateFrom, dateTo, orderBy='asc', includeScans='1', includeWanted='1' } = req.query;

    // بناء فلتر المناديب
    let agentIds = [];
    if (agents && agents !== 'all') {
      agentIds = agents.split(',').map(Number).filter(Boolean);
    }

    const order = orderBy === 'desc' ? 'DESC' : 'ASC';
    const dateFilter = dateFrom && dateTo
      ? `AND s.created_at BETWEEN '${dateFrom}' AND '${dateTo} 23:59:59'`
      : dateFrom ? `AND s.created_at >= '${dateFrom}'`
      : dateTo   ? `AND s.created_at <= '${dateTo} 23:59:59'`
      : '';

    const agentFilter = agentIds.length > 0
      ? `AND s.user_id IN (${agentIds.join(',')})`
      : '';

    // السجلات
    const scans = includeScans === '1' ? db.prepare(`
      SELECT s.id, s.plate, s.plate_spaced, s.user_name, s.group_name,
             s.lat, s.lng, s.note, s.is_wanted,
             w.company as wanted_company, w.model as wanted_model, w.portfolio as wanted_portfolio,
             s.created_at
      FROM scans s
      LEFT JOIN wanted w ON s.plate = w.plate
      WHERE 1=1 ${dateFilter} ${agentFilter}
      ORDER BY s.id ${order}
    `).all() : [];

    // المطلوبات فقط
    const wanted = includeWanted === '1' ? db.prepare(`
      SELECT s.id, s.plate, s.plate_spaced, s.user_name, s.group_name,
             s.lat, s.lng, s.note,
             w.company, w.model, w.portfolio, w.reason,
             s.created_at
      FROM scans s
      INNER JOIN wanted w ON s.plate = w.plate
      WHERE 1=1 ${dateFilter} ${agentFilter}
      ORDER BY s.id ${order}
    `).all() : [];

    // بناء Excel
    const XLSX = require('xlsx');
    const wb = XLSX.utils.book_new();

    if (includeScans === '1') {
      const scansData = [
        ['#','اللوحة','اللوحة مفصولة','المندوب','المجموعة','مطلوبة','الجهة','الموديل','المحفظة','الملاحظة','خط العرض','خط الطول','رابط الموقع','التاريخ'],
        ...scans.map(r => [
          r.id, r.plate, r.plate_spaced||r.plate, r.user_name||'', r.group_name||'',
          r.is_wanted?'نعم':'لا', r.wanted_company||'', r.wanted_model||'', r.wanted_portfolio||'',
          r.note||'', r.lat||'', r.lng||'',
          r.lat&&r.lng?`https://maps.google.com/?q=${r.lat},${r.lng}`:'',
          r.created_at||''
        ])
      ];
      const ws1 = XLSX.utils.aoa_to_sheet(scansData);
      ws1['!cols'] = [{wch:6},{wch:12},{wch:16},{wch:14},{wch:12},{wch:8},{wch:14},{wch:14},{wch:12},{wch:16},{wch:12},{wch:12},{wch:40},{wch:20}];
      XLSX.utils.book_append_sheet(wb, ws1, 'السجلات');
    }

    if (includeWanted === '1' && wanted.length > 0) {
      const wantedData = [
        ['#','اللوحة','اللوحة مفصولة','المندوب','المجموعة','الجهة','الموديل','المحفظة','السبب','الملاحظة','خط العرض','خط الطول','رابط الموقع','التاريخ'],
        ...wanted.map(r => [
          r.id, r.plate, r.plate_spaced||r.plate, r.user_name||'', r.group_name||'',
          r.company||'', r.model||'', r.portfolio||'', r.reason||'', r.note||'',
          r.lat||'', r.lng||'',
          r.lat&&r.lng?`https://maps.google.com/?q=${r.lat},${r.lng}`:'',
          r.created_at||''
        ])
      ];
      const ws2 = XLSX.utils.aoa_to_sheet(wantedData);
      ws2['!cols'] = [{wch:6},{wch:12},{wch:16},{wch:14},{wch:12},{wch:14},{wch:14},{wch:12},{wch:14},{wch:16},{wch:12},{wch:12},{wch:40},{wch:20}];
      XLSX.utils.book_append_sheet(wb, ws2, 'المطلوبات');
    }

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const today = new Date().toISOString().slice(0,10);
    res.setHeader('Content-Disposition', `attachment; filename="hunter-export-${today}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);

    logActivity(req.user.id, req.user.full_name||req.user.username, 'export_advanced',
      `تصدير متقدم: ${scans.length} سجل، ${wanted.length} مطلوبة`, '');
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── دالة تسجيل النشاط ─────────────────────────────────────────
function logActivity(userId, userName, action, detail, groupName) {
  try {
    db.prepare('INSERT INTO activity_log (user_id, user_name, action, detail, group_name) VALUES (?,?,?,?,?)')
      .run(userId||0, userName||'مجهول', action, detail||'', groupName||'');
  } catch(e) {}
}

// ── endpoint سجل النشاط ───────────────────────────────────────
// ── إحصائيات المطلوبات المرصودة ─────────────────────────────────
app.get('/api/admin/wanted-stats', authMiddleware, adminOnly, (req, res) => {
  const { period = 'today' } = req.query;
  const dateFilter = period === 'today'
    ? "AND DATE(s.created_at) = DATE('now','localtime')"
    : period === 'week'
    ? "AND s.created_at >= datetime('now','-7 days','localtime')"
    : '';

  // إجمالي
  const total = db.prepare(`
    SELECT COUNT(*) as count FROM scans s
    INNER JOIN wanted w ON s.plate = w.plate
    WHERE 1=1 ${dateFilter}
  `).get();

  // حسب الشركة
  const byCompany = db.prepare(`
    SELECT w.company as name, COUNT(*) as count
    FROM scans s INNER JOIN wanted w ON s.plate = w.plate
    WHERE 1=1 ${dateFilter}
    GROUP BY w.company ORDER BY count DESC LIMIT 10
  `).all();

  // حسب الحي (من الملاحظة أو الموقع)
  const byArea = db.prepare(`
    SELECT COALESCE(s.area, 'غير محدد') as name, COUNT(*) as count
    FROM scans s INNER JOIN wanted w ON s.plate = w.plate
    WHERE 1=1 ${dateFilter}
    GROUP BY s.area ORDER BY count DESC LIMIT 10
  `).all();

  // حسب المندوب
  const byAgent = db.prepare(`
    SELECT s.user_name as name, COUNT(*) as count
    FROM scans s INNER JOIN wanted w ON s.plate = w.plate
    WHERE 1=1 ${dateFilter}
    GROUP BY s.user_name ORDER BY count DESC LIMIT 10
  `).all();

  // أحدث المطلوبات
  const recent = db.prepare(`
    SELECT s.plate, s.plate_spaced, s.user_name, s.group_name,
           w.company, w.model, s.area, s.created_at
    FROM scans s INNER JOIN wanted w ON s.plate = w.plate
    WHERE 1=1 ${dateFilter}
    ORDER BY s.id DESC LIMIT 20
  `).all();

  res.json({ total: total.count, byCompany, byArea, byAgent, recent });
});

// ── endpoint للمشرف — مطلوبات مجموعته فقط ──────────────────────
app.get('/api/group/wanted-stats', authMiddleware, groupAdminOnly, (req, res) => {
  const groupName = req.user.role === 'admin' ? req.query.group : req.user.group_name;
  const { period = 'today' } = req.query;
  const dateFilter = period === 'today'
    ? "AND DATE(s.created_at) = DATE('now','localtime')"
    : period === 'week'
    ? "AND s.created_at >= datetime('now','-7 days','localtime')"
    : '';

  const agentIds = db.prepare(`SELECT id FROM users WHERE group_name = ? OR id = ?`).all(groupName, req.user.id).map(u=>u.id);
  if (!agentIds.length) return res.json({ total:0, byAgent:[], recent:[] });
  const inList = agentIds.join(',');

  const total = db.prepare(`
    SELECT COUNT(*) as count FROM scans s
    INNER JOIN wanted w ON s.plate = w.plate
    WHERE s.user_id IN (${inList}) ${dateFilter}
  `).get();

  const byAgent = db.prepare(`
    SELECT s.user_name as name, COUNT(*) as count
    FROM scans s INNER JOIN wanted w ON s.plate = w.plate
    WHERE s.user_id IN (${inList}) ${dateFilter}
    GROUP BY s.user_name ORDER BY count DESC
  `).all();

  const recent = db.prepare(`
    SELECT s.plate, s.plate_spaced, s.user_name, w.company, w.model, s.created_at
    FROM scans s INNER JOIN wanted w ON s.plate = w.plate
    WHERE s.user_id IN (${inList}) ${dateFilter}
    ORDER BY s.id DESC LIMIT 10
  `).all();

  res.json({ total: total.count, byAgent, recent });
});

app.get('/api/admin/activity-log', authMiddleware, adminOnly, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit)||100, 500);
  const type  = req.query.type;
  const rows = type
    ? db.prepare('SELECT * FROM activity_log WHERE action=? ORDER BY created_at DESC LIMIT ?').all(type, limit)
    : db.prepare('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT ?').all(limit);
  res.json(rows);
});

// تشغيل السيرفر

// Keep-Alive
setInterval(() => { try { require('http').get('http://localhost:'+(process.env.PORT||3000)+'/ping', ()=>{}); } catch(e){} }, 240000);

app.listen(PORT, () => console.log(`🚀 هنتر Backend يعمل على المنفذ ${PORT}`));

// ── رفع ملف إكسل للمطلوبة (preview) ────────────────────────────────
app.post('/api/admin/wanted/upload-preview', authMiddleware, adminOnly,
  upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'لم يتم إرفاق ملف' });
    try {
      const result = processExcelBuffer(req.file.buffer, req.body.company || '');
      res.json({
        success: true,
        preview: result.plates.slice(0, 20),
        total: result.plates.length,
        errors: result.errors.slice(0, 10),
        sheet: result.sheet,
        all: result.plates,
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

// ── تأكيد رفع الملف وحفظه ───────────────────────────────────────────
app.post('/api/admin/wanted/upload-confirm', authMiddleware, adminOnly, (req, res) => {
  const { plates, replace } = req.body;
  if (!plates || !Array.isArray(plates)) return res.status(400).json({ error: 'لا توجد بيانات' });

  let added = 0, skipped = 0, updated = 0;

  const insertStmt = db.prepare(`
    INSERT INTO wanted (plate, reason, company, model, added_by)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(plate) DO UPDATE SET
      company = excluded.company,
      model = excluded.model,
      added_by = excluded.added_by
  `);

  const doInsert = db.transaction((items) => {
    if (replace) db.prepare('DELETE FROM wanted').run();
    for (const p of items) {
      try {
        const existing = db.prepare('SELECT id FROM wanted WHERE plate = ?').get(p.plate);
        insertStmt.run(p.plate, p.reason || null, p.company || null, p.model || null, req.user.full_name);
        if (existing) updated++; else added++;
      } catch { skipped++; }
    }
  });

  doInsert(plates);
  res.json({ success: true, added, updated, skipped, total: plates.length });
});

// ══ نظام المحافظ (Portfolio) ════════════════════════════════════════

// جدول المحافظ — كل محفظة لها اسم وتاريخ آخر تحديث
db.exec(`
  CREATE TABLE IF NOT EXISTS portfolios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    total_plates INTEGER DEFAULT 0,
    updated_by TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// ─── عرض المحافظ ────────────────────────────────────────────────
app.get('/api/admin/portfolios', authMiddleware, adminOnly, (req, res) => {
  const list = db.prepare(`
    SELECT p.*, COUNT(w.id) as plate_count
    FROM portfolios p
    LEFT JOIN wanted w ON w.portfolio = p.name
    GROUP BY p.id ORDER BY p.updated_at DESC
  `).all();
  res.json(list);
});

// ─── رفع محفظة كاملة (تستبدل القديمة بنفس الاسم) ───────────────
app.post('/api/admin/portfolios/upload', authMiddleware, adminOnly,
  upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'لم يتم إرفاق ملف' });

    const portfolioName = (req.body.portfolio_name || '').trim();
    if (!portfolioName) return res.status(400).json({ error: 'أدخل اسم المحفظة' });

    try {
      // تحقق من حجم الملف
      if (req.file.buffer.length > 50 * 1024 * 1024) {
        return res.status(400).json({ error: 'حجم الملف كبير جداً (الحد الأقصى 50MB)' });
      }

      let result;
      try {
        result = processExcelBuffer(req.file.buffer, portfolioName);
      } catch (parseErr) {
        return res.status(400).json({ error: 'تعذر قراءة الملف: ' + parseErr.message });
      }

      if (!result || !result.plates) {
        return res.status(400).json({ error: 'الملف فارغ أو لا يحتوي على بيانات صالحة' });
      }

      res.json({
        success: true,
        portfolio: portfolioName,
        preview: result.plates.slice(0, 20),
        total: result.plates.length,
        errors: result.errors.slice(0, 10),
        sheet: result.sheet,
        all: result.plates,
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

// معالج أخطاء multer
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'حجم الملف كبير جداً (الحد الأقصى 50MB)' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(400).json({ error: 'حجم البيانات كبير جداً' });
  }
  res.status(500).json({ error: err.message || 'خطأ في السيرفر' });
});

// ─── تأكيد حفظ المحفظة (يحذف القديمة ويضيف الجديدة) ───────────
app.post('/api/admin/portfolios/confirm', authMiddleware, adminOnly, (req, res) => {
  const { portfolio_name, plates, mode = 'replace' } = req.body;
  if (!portfolio_name || !plates?.length) {
    return res.status(400).json({ error: 'بيانات ناقصة' });
  }

  const doAll = db.transaction(() => {
    let deleted = { changes: 0 };
    if (mode === 'replace') {
      // استبدال كامل — احذف القديمة فقط
      deleted = db.prepare("DELETE FROM wanted WHERE portfolio = ?").run(portfolio_name);
    }
    // dedup — لا تحذف القديمة

    // ٢. أضف اللوحات الجديدة
    const now = new Date().toISOString();
    const ins = db.prepare(`
      INSERT OR REPLACE INTO wanted (plate, reason, company, model, portfolio, added_by, last_portfolio_update)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    let added = 0;
    for (const p of plates) {
      ins.run(p.plate, p.reason || null, p.company || null, p.model || null, portfolio_name, req.user.full_name, now);
      added++;
    }

    // ٣. سجّل المحفظة
    db.prepare(`
      INSERT INTO portfolios (name, total_plates, updated_by, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(name) DO UPDATE SET
        total_plates = excluded.total_plates,
        updated_by   = excluded.updated_by,
        updated_at   = excluded.updated_at
    `).run(portfolio_name, added, req.user.full_name);

    return { deleted: deleted.changes, added };
  });

  const result = doAll();
  res.json({ success: true, ...result, portfolio: portfolio_name });
});

// ─── حذف محفظة كاملة ───────────────────────────────────────────
app.delete('/api/admin/portfolios/:name', authMiddleware, adminOnly, (req, res) => {
  const name = decodeURIComponent(req.params.name);
  db.prepare("DELETE FROM wanted WHERE portfolio = ?").run(name);
  db.prepare("DELETE FROM portfolios WHERE name = ?").run(name);
  res.json({ success: true });
});

// ─── لوحات جديدة في المحفظة (مقارنة بآخر تحميل) ─────────────────
app.post('/api/admin/portfolios/diff', authMiddleware, adminOnly, (req, res) => {
  const { portfolio_name, plates } = req.body;
  if (!portfolio_name || !plates?.length) return res.status(400).json({ error: 'بيانات ناقصة' });

  // اللوحات الموجودة حالياً في هذه المحفظة
  const existing = db.prepare("SELECT plate FROM wanted WHERE portfolio = ?").all(portfolio_name).map(r => r.plate);
  const existingSet = new Set(existing);
  const newSet = new Set(plates.map(p => p.plate));

  const newPlates    = plates.filter(p => !existingSet.has(p.plate)); // جديدة لم تكن موجودة
  const removedPlates = existing.filter(p => !newSet.has(p));         // محذوفة من الملف الجديد

  res.json({
    new_count:     newPlates.length,
    removed_count: removedPlates.length,
    new_plates:    newPlates.slice(0, 50),
    removed_plates: removedPlates.slice(0, 50),
  });
});

// ─── إحصائيات اليوم للسيرفر ─────────────────────────────────────
app.get('/api/admin/stats/today', authMiddleware, adminOnly, (req, res) => {
  const agents = db.prepare(`
    SELECT user_name, user_id, COUNT(*) as count,
           SUM(CASE WHEN is_wanted=1 THEN 1 ELSE 0 END) as wanted_count
    FROM scans
    WHERE date(created_at) = date('now')
    GROUP BY user_id ORDER BY count DESC
  `).all();
  res.json({ agents, date: new Date().toLocaleDateString('ar-SA') });
});

// ── تصدير سجلات المندوب (Excel/CSV) ────────────────────────────────
app.get('/api/scans/export', authMiddleware, (req, res) => {
  // المشرف دائماً يستطيع، المندوب يحتاج صلاحية
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (req.user.role !== 'admin' && !user.can_export_scans) {
    return res.status(403).json({ error: 'ليس لديك صلاحية تصدير السجلات' });
  }

  const today_only = req.query.today === '1';
  const filter = today_only ? "AND date(s.created_at) = date('now')" : '';
  const limit  = req.user.role === 'admin' ? 10000 : 1000;

  const scans = db.prepare(`
    SELECT s.*, w.company as w_company, w.model as w_model, w.portfolio as w_portfolio
    FROM scans s
    LEFT JOIN wanted w ON s.plate = w.plate
    WHERE s.user_id = ? ${filter}
    ORDER BY s.created_at DESC LIMIT ?
  `).all(req.user.id, limit);

  res.json(scans.map(s => ({
    plate:           s.plate,
    plate_spaced:    s.plate_spaced || s.plate,
    is_wanted:       s.is_wanted ? 'نعم' : 'لا',
    wanted_company:  s.wanted_company || s.w_company || '',
    wanted_model:    s.wanted_model   || s.w_model   || '',
    wanted_portfolio:s.wanted_portfolio|| s.w_portfolio|| '',
    note:            s.note || '',
    lat:             s.lat,
    lng:             s.lng,
    user_name:       s.user_name,
    group_name:      s.group_name || '',
    created_at:      s.created_at,
  })));
  logActivity(req.user.id, req.user.full_name||req.user.username, 'export_scans',
    `سحب السجلات`, req.user.group_name);
});

// ── تصدير المطلوبات التي وجدها المندوب ──────────────────────────────
app.get('/api/scans/export-wanted', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (req.user.role !== 'admin' && !user.can_export_wanted) {
    return res.status(403).json({ error: 'ليس لديك صلاحية تصدير المطلوبات' });
  }

  // جلب كل السجلات التي تطابقت مع المحافظ (سواء وقت التسجيل أو بعده)
  const scans = db.prepare(`
    SELECT s.plate, s.plate_spaced, s.lat, s.lng, s.note,
           s.created_at, s.user_name,
           w.company, w.model, w.portfolio, w.reason
    FROM scans s
    INNER JOIN wanted w ON s.plate = w.plate
    WHERE s.user_id = ?
    ORDER BY s.created_at DESC
  `).all(req.user.id);

  // إزالة المكررات — نبقي آخر رصد لكل لوحة
  const seen = new Set();
  const unique = scans.filter(s => {
    if (seen.has(s.plate)) return false;
    seen.add(s.plate);
    return true;
  });

  logActivity(req.user.id, req.user.full_name||req.user.username, 'export_wanted',
    `سحب الإحالات (${unique.length})`, req.user.group_name);
  res.json(unique.map(s => ({
    plate:            s.plate,
    plate_spaced:     s.plate_spaced || s.plate,
    user_name:        s.user_name || '',
    wanted_company:   s.company || '',
    wanted_model:     s.model   || '',
    wanted_portfolio: s.portfolio || '',
    wanted_reason:    s.reason  || '',
    note:             s.note    || '',
    lat:              s.lat,
    lng:              s.lng,
    map_link:         s.lat && s.lng ? `https://maps.google.com/?q=${s.lat},${s.lng}` : '',
    created_at:       s.created_at,
  })));
});

// ── لوحات مطلوبة جديدة لم يرصدها المندوب من قبل (إحالة مطلوبة) ──
app.get('/api/scans/new-wanted', authMiddleware, (req, res) => {
  // سجّل آخر مرة فتح المندوب هذه الشاشة (لحساب الجديد)
  const lastSeenRow = db.prepare('SELECT last_seen FROM agent_last_seen WHERE user_id = ?').get(req.user.id);
  const lastSeen = lastSeenRow?.last_seen || '1970-01-01';

  // حدّث وقت الزيارة
  db.prepare(`
    INSERT INTO agent_last_seen (user_id, last_seen) VALUES (?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET last_seen = datetime('now')
  `).run(req.user.id);

  // كل سجلات المندوب (مطلوبة وغير مطلوبة) لمعرفة المواقع
  const allMyScans = db.prepare(`
    SELECT plate, lat, lng, note, created_at
    FROM scans 
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(req.user.id);
  
  // مجموعة اللوحات المرصودة (المطلوبة فقط)
  const seenScans = db.prepare(`
    SELECT DISTINCT plate FROM scans WHERE user_id = ? AND is_wanted = 1
  `).all(req.user.id);
  const seenSet = new Set(seenScans.map(s => s.plate));
  
  // خريطة لكل مواقع الرصد لكل لوحة (قد تكون متعددة)
  const seenMap = {};
  allMyScans.forEach(s => {
    if (!seenMap[s.plate]) seenMap[s.plate] = [];
    seenMap[s.plate].push({
      lat: s.lat, lng: s.lng,
      note: s.note,
      time: s.created_at,
    });
  });

  // ── المنطق الصحيح ──────────────────────────────────────────────
  // لوحات المحافظ التي رصدها المندوب فعلاً (تطابق بين سجلاته والمحافظ)
  // نجلبها من scans مباشرة (is_wanted = 1 يعني تطابقت وقت التسجيل)
  const myFoundScans = db.prepare(`
    SELECT s.plate, s.lat, s.lng, s.note, s.created_at as scan_time,
           w.company, w.model, w.portfolio, w.reason,
           w.last_portfolio_update, w.created_at as wanted_added_at
    FROM scans s
    INNER JOIN wanted w ON s.plate = w.plate
    WHERE s.user_id = ?
    ORDER BY s.created_at DESC
  `).all(req.user.id);

  // تجميع كل مواقع الرصد لكل لوحة
  const foundMap = {};
  myFoundScans.forEach(s => {
    if (!foundMap[s.plate]) {
      foundMap[s.plate] = {
        plate: s.plate,
        company: s.company,
        model: s.model,
        portfolio: s.portfolio,
        reason: s.reason,
        last_portfolio_update: s.last_portfolio_update,
        wanted_added_at: s.wanted_added_at,
        scan_locations: [],
      };
    }
    foundMap[s.plate].scan_locations.push({
      lat: s.lat, lng: s.lng,
      note: s.note, time: s.created_at,
    });
  });

  const allFoundByMe = Object.values(foundMap);

  // رصدتها اليوم = من SQL مباشرة — أدق من JavaScript filter
  const recentFoundPlates = new Set(
    db.prepare(`
      SELECT DISTINCT s.plate 
      FROM scans s
      INNER JOIN wanted w ON s.plate = w.plate
      WHERE s.user_id = ? 
        AND s.created_at >= datetime('now', '-2 days')
    `).all(req.user.id).map(r => r.plate)
  );

  // رصدتها = اللوحات المرصودة في آخر يومين
  const foundByMe = allFoundByMe.filter(w => recentFoundPlates.has(w.plate));

  // إحالات جديدة = المنطق الصحيح:
  // اللوحة "جديدة" على المندوب إذا:
  // - أُضيفت للمحفظة (last_portfolio_update) بعد آخر تسجيل للمندوب لها (scan_time)
  // بمعنى: المندوب سجّلها في الماضي → ثم أُضيفت للمحفظة لاحقاً → هي جديدة عليه كإحالة
  // أما اللوحات التي كانت في المحفظة قبل تسجيله → لا تظهر كجديدة (كان يجب يعرف عنها)
  const newReferrals = allFoundByMe.filter(w => {
    // وقت آخر تسجيل للمندوب لهذه اللوحة
    const lastScanTime = w.scan_locations?.[0]?.time || '1970-01-01';
    // الإحالة جديدة إذا أُضيفت للمحفظة بعد آخر مرة سجّلها المندوب
    return w.last_portfolio_update > lastScanTime;
  });

  // الكل = كل اللوحات المطلوبة التي رصدها في أي وقت
  const oldUnfound = allFoundByMe;

  // إجمالي لوحات المحافظ (للإحصاء فقط)
  const totalWanted = db.prepare('SELECT COUNT(*) as c FROM wanted').get().c;


  res.json({
    new_referrals:  newReferrals,  // إحالات جديدة منذ آخر زيارة
    found_by_me:    foundByMe,     // رصدتها اليوم فقط
    old_unfound:    oldUnfound,    // كل اللوحات المطلوبة التي رصدتها (كل الأيام)
    new_count:      newReferrals.length,
    found_count:    foundByMe.length,
    total_wanted:   totalWanted,
  });
});
