const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const { processExcelBuffer } = require('./upload_handler');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'hunter-secret-change-in-production-2024';

app.use(cors());
app.use(express.json());

// ── قاعدة البيانات ──────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'hunter.db'));

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

  CREATE TABLE IF NOT EXISTS agent_last_seen (
    user_id INTEGER PRIMARY KEY,
    last_seen TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

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
    next();
  } catch {
    res.status(401).json({ error: 'جلسة منتهية، سجّل دخولك مجدداً' });
  }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'للمشرفين فقط' });
  next();
}

// ── تسجيل الدخول ────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password, device_id } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'أدخل اسم المستخدم وكلمة المرور' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || user.password_hash !== hashPassword(password)) {
    return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور خاطئة' });
  }
  if (!user.is_active) {
    return res.status(403).json({ error: 'الحساب موقوف، تواصل مع المشرف' });
  }

  // تحقق من الجهاز (للمناديب فقط)
  if (user.role === 'agent' && device_id) {
    if (user.device_id && user.device_id !== device_id) {
      return res.status(403).json({ error: 'هذا الحساب مسجل على جهاز آخر. تواصل مع المشرف' });
    }
    if (!user.device_id) {
      db.prepare('UPDATE users SET device_id = ? WHERE id = ?').run(device_id, user.id);
    }
  }

  const token = jwt.sign(
    { id: user.id, username: user.username, full_name: user.full_name, role: user.role, group_name: user.group_name, can_export_scans: !!user.can_export_scans, can_export_wanted: !!user.can_export_wanted },
    JWT_SECRET,
    { expiresIn: '30d' }
  );

  res.json({ token, user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role, group_name: user.group_name, can_export_scans: !!user.can_export_scans, can_export_wanted: !!user.can_export_wanted } });
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
  const limit  = parseInt(req.query.limit) || 50;
  const hours  = req.query.hours ? parseInt(req.query.hours) : null; // فلتر 24 ساعة
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
  const { from, to, user_id, plate, wanted_only, limit = 500 } = req.query;

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
  const users = db.prepare('SELECT id, username, full_name, role, group_name, is_active, device_id, can_export_scans, can_export_wanted, created_at FROM users').all();
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
  const { is_active, device_id, password, can_export_scans, can_export_wanted } = req.body;
  const { id } = req.params;
  if (is_active !== undefined)         db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(is_active ? 1 : 0, id);
  if (device_id === null)              db.prepare('UPDATE users SET device_id = NULL WHERE id = ?').run(id);
  if (password)                        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), id);
  if (can_export_scans !== undefined)  db.prepare('UPDATE users SET can_export_scans = ? WHERE id = ?').run(can_export_scans ? 1 : 0, id);
  if (can_export_wanted !== undefined) db.prepare('UPDATE users SET can_export_wanted = ? WHERE id = ?').run(can_export_wanted ? 1 : 0, id);
  res.json({ success: true });
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

// تشغيل السيرفر
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
      const result = processExcelBuffer(req.file.buffer, portfolioName);

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

// ─── تأكيد حفظ المحفظة (يحذف القديمة ويضيف الجديدة) ───────────
app.post('/api/admin/portfolios/confirm', authMiddleware, adminOnly, (req, res) => {
  const { portfolio_name, plates } = req.body;
  if (!portfolio_name || !plates?.length) {
    return res.status(400).json({ error: 'بيانات ناقصة' });
  }

  const doAll = db.transaction(() => {
    // ١. احذف كل لوحات هذه المحفظة القديمة
    const deleted = db.prepare("DELETE FROM wanted WHERE portfolio = ?").run(portfolio_name);

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
});

// ── تصدير المطلوبات التي وجدها المندوب ──────────────────────────────
app.get('/api/scans/export-wanted', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (req.user.role !== 'admin' && !user.can_export_wanted) {
    return res.status(403).json({ error: 'ليس لديك صلاحية تصدير المطلوبات' });
  }

  const scans = db.prepare(`
    SELECT s.*, w.company as w_company, w.model as w_model,
           w.portfolio as w_portfolio, w.reason as w_reason
    FROM scans s
    LEFT JOIN wanted w ON s.plate = w.plate
    WHERE s.user_id = ? AND s.is_wanted = 1
    ORDER BY s.created_at DESC
  `).all(req.user.id);

  res.json(scans.map(s => ({
    plate:           s.plate,
    plate_spaced:    s.plate_spaced || s.plate,
    wanted_company:  s.wanted_company || s.w_company || '',
    wanted_model:    s.wanted_model   || s.w_model   || '',
    wanted_portfolio:s.wanted_portfolio|| s.w_portfolio|| '',
    wanted_reason:   s.w_reason || '',
    note:            s.note || '',
    lat:             s.lat,
    lng:             s.lng,
    created_at:      s.created_at,
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

  // اللوحات التي رصدها المندوب من قبل
  const seen = db.prepare(`
    SELECT DISTINCT plate FROM scans WHERE user_id = ? AND is_wanted = 1
  `).all(req.user.id).map(r => r.plate);
  const seenSet = new Set(seen);

  // كل اللوحات المطلوبة الحالية
  const allWanted = db.prepare('SELECT * FROM wanted ORDER BY last_portfolio_update DESC, created_at DESC').all();

  const result = allWanted.map(w => ({
    ...w,
    is_found_by_me: seenSet.has(w.plate),           // رصدتها أنا
    is_new_in_portfolio: w.last_portfolio_update > lastSeen, // جديدة منذ آخر مرة فتحت التطبيق
  }));

  // إحالات جديدة: في المحفظة + لم أرصدها + أُضيفت بعد آخر زيارة
  const newReferrals = result.filter(w => !w.is_found_by_me && w.is_new_in_portfolio);
  // لوح مطلوبة: رصدتها أنا
  const foundByMe   = result.filter(w => w.is_found_by_me);
  // قديمة لم أرصدها
  const oldUnfound  = result.filter(w => !w.is_found_by_me && !w.is_new_in_portfolio);

  res.json({
    new_referrals:     newReferrals,    // إحالات جديدة — تنبيه خاص
    found_by_me:       foundByMe,       // لوح مطلوبة رصدتها
    old_unfound:       oldUnfound,      // مطلوبة قديمة لم أرصدها
    new_count:         newReferrals.length,
    found_count:       foundByMe.length,
    total_wanted:      allWanted.length,
  });
});
