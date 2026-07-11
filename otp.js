const nodemailer = require('nodemailer');

// ── إعدادات SMTP من متغيرات البيئة (Railway) ──────────────────────
// SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
// أي مزود SMTP يشتغل: Gmail (بكلمة مرور تطبيق)، Outlook، Zoho، مزود الشركة...
let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return null; // الإيميل غير مُعد بعد — راجع ملاحظة الإعداد بالأسفل
  }
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transporter;
}

// ── تخزين مؤقت بالذاكرة لرموز OTP المعلّقة (تنتهي خلال 5 دقائق) ──
// مفتاح كل عملية = pending_token عشوائي، القيمة = { userId, code, expiresAt, attempts }
const pendingOtps = new Map();

const OTP_EXPIRY_MS = 5 * 60 * 1000;   // 5 دقائق
const MAX_ATTEMPTS  = 5;

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 أرقام
}

function generatePendingToken() {
  return require('crypto').randomBytes(24).toString('hex');
}

// ينظف الرموز المنتهية دورياً (تفادي تراكم بالذاكرة)
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, val] of pendingOtps.entries()) {
    if (now > val.expiresAt) pendingOtps.delete(key);
  }
}, 60 * 1000);
cleanupInterval.unref();

// ── إرسال رمز جديد لمستخدم، يرجّع pending_token ──────────────────
async function createAndSendOtp(user) {
  const t = getTransporter();
  if (!t) throw new Error('التحقق الإضافي غير مفعّل على السيرفر — راجع إعدادات SMTP');

  const code = generateCode();
  const pendingToken = generatePendingToken();
  pendingOtps.set(pendingToken, {
    userId: user.id,
    code,
    expiresAt: Date.now() + OTP_EXPIRY_MS,
    attempts: 0,
  });

  await t.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: user.email,
    subject: 'رمز الدخول — Hunter',
    text: `رمز الدخول الخاص بك: ${code}\nصالح لمدة 5 دقائق. لا تشاركه مع أحد.`,
    html: `<div dir="rtl" style="font-family:sans-serif">
      <p>رمز الدخول الخاص بك:</p>
      <h2 style="letter-spacing:4px">${code}</h2>
      <p style="color:#888;font-size:13px">صالح لمدة 5 دقائق. لا تشاركه مع أحد.</p>
    </div>`,
  });

  return pendingToken;
}

// ── التحقق من الرمز المُدخل ────────────────────────────────────────
// يرجّع { ok: true, userId } أو { ok: false, error }
function verifyOtp(pendingToken, code) {
  const entry = pendingOtps.get(pendingToken);
  if (!entry) return { ok: false, error: 'انتهت صلاحية الرمز، سجّل الدخول من جديد' };
  if (Date.now() > entry.expiresAt) {
    pendingOtps.delete(pendingToken);
    return { ok: false, error: 'انتهت صلاحية الرمز، سجّل الدخول من جديد' };
  }
  entry.attempts++;
  if (entry.attempts > MAX_ATTEMPTS) {
    pendingOtps.delete(pendingToken);
    return { ok: false, error: 'محاولات كثيرة، سجّل الدخول من جديد' };
  }
  if (entry.code !== String(code).trim()) {
    return { ok: false, error: 'الرمز غير صحيح' };
  }
  pendingOtps.delete(pendingToken);
  return { ok: true, userId: entry.userId };
}

module.exports = { createAndSendOtp, verifyOtp, isEmailConfigured: () => !!getTransporter() };
