// ── نظام تحليل وتوحيد لوحات المركبات السعودية ────────────────────

// خريطة تصحيح الحروف: حرف غير معتمد → حرف معتمد
const LETTER_MAP = {
  'ا': 'أ', 'إ': 'أ', 'آ': 'أ',   // ألف بأشكالها → أ
  'ث': 'ب',                          // ث → ب
  'ج': 'ح',                          // ج → ح
  'خ': 'ح',                          // خ → ح
  'ذ': 'ر',                          // ذ → ر
  'ز': 'ر',                          // ز → ر
  'ش': 'س',                          // ش → س
  'ض': 'ص',                          // ض → ص
  'ظ': 'ط',                          // ظ → ط
  'غ': 'ع',                          // غ → ع
  'ف': 'ق',  'ڤ': 'ق',              // ف → ق
  'ة': 'ه',  'ھ': 'ه', 'ہ': 'ه',   // هاء بأشكالها → ه
  'ء': 'أ',  'ؤ': 'و', 'ئ': 'ى',   // همزات
  'ي': 'ى',  'ی': 'ى',              // ياء → ى
  'د': 'د',  'ك': 'ك',              // تثبيت
};

// الحروف المعتمدة
const VALID_LETTERS = new Set(['أ','ب','ح','ر','س','ص','ط','ع','ق','ك','ل','م','ن','ه','و','ى','د']);

// تحويل الأرقام العربية/الفارسية لإنجليزية
function toEnglishDigits(str) {
  return str
    .replace(/[٠-٩]/g, d => d.charCodeAt(0) - '٠'.charCodeAt(0))
    .replace(/[۰-۹]/g, d => d.charCodeAt(0) - '۰'.charCodeAt(0));
}

// تصحيح حرف واحد
function fixLetter(ch) {
  return LETTER_MAP[ch] || (VALID_LETTERS.has(ch) ? ch : null);
}

// تحليل نص اللوحة وإرجاع { letters, numbers, normalized, valid }
function parsePlate(raw) {
  if (!raw) return null;
  const str = toEnglishDigits(String(raw).trim());

  // استخراج الأرقام
  const numMatch = str.match(/\d+/);
  const rawNumbers = numMatch ? numMatch[0] : '';
  // تكملة لـ 4 خانات
  const numbers = rawNumbers.padStart(4, '0').slice(-4);

  // استخراج الحروف (العربية فقط)
  const rawLetters = str.replace(/[\d\s\-_./]/g, '').split('');

  // تصحيح الحروف
  const fixedLetters = rawLetters.map(fixLetter).filter(Boolean);

  if (fixedLetters.length === 0 || rawNumbers === '') {
    return { letters: '', numbers: '', normalized: str.replace(/\s+/g, ''), valid: false, raw };
  }

  const letters = fixedLetters.join('');
  const normalized = letters + numbers;

  return { letters, numbers, normalized, valid: true, raw };
}

// ── كشف عمود اللوحة من headers ─────────────────────────────────────
const PLATE_KEYWORDS = ['لوحة', 'لوحه', 'اللوحة', 'اللوحه', 'plate', 'رقم اللوح'];
const MODEL_KEYWORDS = ['طراز', 'نوع', 'موديل', 'ماركة', 'ماركه', 'model', 'manufacturer', 'صانع'];
const COMPANY_KEYWORDS = ['شركة', 'البنك', 'company', 'القسم', 'جهة', 'مصدر'];

function detectColumns(headers) {
  let plateCol = -1, modelCol = -1, companyCol = -1;
  headers.forEach((h, i) => {
    if (!h) return;
    const lower = String(h).toLowerCase().trim();
    if (PLATE_KEYWORDS.some(k => lower.includes(k))) plateCol = i;
    if (MODEL_KEYWORDS.some(k => lower.includes(k)) && modelCol === -1) modelCol = i;
    if (COMPANY_KEYWORDS.some(k => lower.includes(k)) && companyCol === -1) companyCol = i;
  });

  // إذا ما لقينا عمود اللوحة من الهيدر، نبحث في أول صف بيانات
  return { plateCol, modelCol, companyCol };
}

// ── هل الخلية تبدو كلوحة؟ ──────────────────────────────────────────
function looksLikePlate(val) {
  if (!val) return false;
  const s = toEnglishDigits(String(val).trim());
  const hasArabic = /[\u0600-\u06FF]/.test(s);
  const hasDigits = /\d/.test(s);
  const notTooLong = s.replace(/\s/g, '').length <= 10;
  return hasArabic && hasDigits && notTooLong;
}

// ── التحليل الكامل للملف ────────────────────────────────────────────
function detectPlateColumnFromData(rows) {
  // جرّب كل عمود وشوف أيها فيه أكثر لوحات
  if (!rows || rows.length === 0) return 0;
  const colCount = rows[0].length;
  const scores = new Array(colCount).fill(0);
  const sample = rows.slice(0, Math.min(20, rows.length));
  sample.forEach(row => {
    row.forEach((cell, i) => {
      if (looksLikePlate(cell)) scores[i]++;
    });
  });
  return scores.indexOf(Math.max(...scores));
}

module.exports = { parsePlate, detectColumns, detectPlateColumnFromData, looksLikePlate, fixLetter, LETTER_MAP };
