// ── محلل اللوحات السعودية ────────────────────────────────────────

// الحروف المعتمدة في اللوحات السعودية (بعد التوحيد)
const VALID_LETTERS = new Set(['ا','ب','ح','ر','س','ص','ط','ع','ق','ك','ل','م','ن','ه','و','ي','د']);

// خريطة تحويل الحروف الإنجليزية → العربية (لوحات سعودية)
const ENG_TO_AR = {
  'A':'ا', 'B':'ب', 'J':'ح', 'D':'د', 'R':'ر', 'S':'س',
  'X':'ص', 'T':'ط', 'E':'ع', 'G':'ق', 'K':'ك', 'L':'ل',
  'Z':'م', 'N':'ن', 'H':'ه', 'U':'و', 'V':'ي',
  // تنويعات شائعة
  'O':'و', 'I':'ي', 'C':'ك', 'P':'ب', 'W':'و',
};

// خريطة تصحيح الحروف — كل حرف غير معتمد يُحوَّل لأقرب معتمد
const LETTER_MAP = {
  // توحيد الألف والهمزة
  'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا',
  // توحيد الياء
  'ى': 'ي', 'ئ': 'ي',
  // توحيد التاء المربوطة
  'ة': 'ه',
  // تصحيح الحروف المتشابهة
  'ث': 'ب',
  'ج': 'ح', 'خ': 'ح',
  'ذ': 'د',
  'ز': 'ر',
  'ش': 'س',
  'ض': 'ص',
  'ظ': 'ط',
  'غ': 'ع',
  'ف': 'ق',
};

/**
 * تصحيح وتوحيد نص اللوحة
 * - يُبقي فقط الحروف والأرقام
 * - يُطبّق خريطة التصحيح
 * - يُكمل الأرقام لـ 4 خانات
 */
function normalizePlate(raw) {
  if (!raw) return null;
  
  // تنظيف: إزالة المسافات والرموز الخاصة
  let text = String(raw).trim()
    .replace(/[_\-\.\/\\،,،؛;:]/g, '') // إزالة فواصل وشرطات
    .replace(/\s+/g, '');          // إزالة كل المسافات
  
  if (!text) return null;
  
  let letters = '';
  let engLetters = '';
  let numbers = '';
  
  for (const ch of text) {
    // مهم: نفحص الأرقام أولاً — الأرقام الهندية (٠-٩) تقع ضمن مدى يونيكود
    // الحروف العربية (U+0600-U+06FF) فلو فحصنا الحروف أولاً بتُصنَّف غلط
    // كحرف عربي غير معتمد وتُحذف بصمت
    if (/[0-9٠-٩۰-۹]/.test(ch)) {
      // رقم — حوّل للإنجليزي
      numbers += ch
        .replace(/[٠-٩]/g, d => d.charCodeAt(0) - '٠'.charCodeAt(0))
        .replace(/[۰-۹]/g, d => d.charCodeAt(0) - '۰'.charCodeAt(0));
    } else if (/[\u0600-\u06FF]/.test(ch)) {
      // حرف عربي — طبّق خريطة التصحيح
      const corrected = LETTER_MAP[ch] || ch;
      if (VALID_LETTERS.has(corrected)) {
        letters += corrected;
      }
    } else if (/[A-Za-z]/.test(ch)) {
      // حرف إنجليزي — حوّل للعربي
      const ar = ENG_TO_AR[ch.toUpperCase()];
      if (ar) engLetters += ar;
    }
  }
  
  if (!letters && !numbers) return null;
  
  // إكمال الأرقام لـ 4 خانات
  if (numbers) {
    numbers = numbers.padStart(4, '0').slice(-4);
  }
  
  // الحروف الإنجليزية دائماً تُعكس في اللوحات السعودية
  const reversedEng = engLetters.split('').reverse().join('');
  const allLetters = letters + reversedEng;
  
  if (!allLetters && !numbers) return null;
  return allLetters + numbers;
}

/**
 * تحويل اللوحة للشكل المفصول: أبس1304 → أ ب س 1304
 */
function spacedPlate(plate) {
  if (!plate) return '';
  const letters = plate.replace(/[0-9]/g, '');
  const nums    = plate.replace(/[^0-9]/g, '');
  return [...letters].join(' ') + (nums ? ' ' + nums : '');
}

/**
 * اكتشاف عمود اللوحة تلقائياً من رأس الجدول
 */
function detectPlateColumn(headers) {
  const plateKeywords = ['لوحة','لوحه','رقم اللوحة','رقم اللوحه','plate','رقم','اللوحة','اللوحه','لوح'];
  for (const kw of plateKeywords) {
    const idx = headers.findIndex(h => 
      String(h || '').trim().toLowerCase().replace(/\s+/g,'').includes(kw.replace(/\s+/g,''))
    );
    if (idx >= 0) return idx;
  }
  return 0; // افتراضي: العمود الأول
}

/**
 * اكتشاف عمود الشركة تلقائياً
 */
function detectCompanyColumn(headers) {
  const keywords = ['شركة','شركه','بنك','جهة','جهه','company','bank','الشركة','الشركه','الجهة'];
  for (const kw of keywords) {
    const idx = headers.findIndex(h =>
      String(h || '').trim().toLowerCase().includes(kw)
    );
    if (idx >= 0) return idx;
  }
  return -1;
}

/**
 * اكتشاف عمود الموديل تلقائياً
 */
function detectModelColumn(headers) {
  const keywords = ['موديل','نوع','model','type','السيارة','المركبة','الموديل'];
  for (const kw of keywords) {
    const idx = headers.findIndex(h =>
      String(h || '').trim().toLowerCase().includes(kw)
    );
    if (idx >= 0) return idx;
  }
  return -1;
}

/**
 * معالجة بيانات الجدول من Excel
 */
function detectPlateColumnFromData(rows) {
  if (!rows || rows.length === 0) return 0;
  
  // جرّب كل عمود وشوف أيهم يحتوي على لوحات صالحة أكثر
  const firstRow = rows[0];
  const colCount = Array.isArray(firstRow) ? firstRow.length : Object.keys(firstRow).length;
  
  let bestCol = 0;
  let bestScore = -1;
  
  for (let col = 0; col < Math.min(colCount, 10); col++) {
    let score = 0;
    const sampleSize = Math.min(rows.length, 20);
    
    for (let row = 0; row < sampleSize; row++) {
      const val = Array.isArray(rows[row]) ? rows[row][col] : Object.values(rows[row])[col];
      const normalized = normalizePlate(String(val || ''));
      if (normalized && normalized.length >= 4 && normalized.length <= 7) {
        score++;
      }
    }
    
    if (score > bestScore) {
      bestScore = score;
      bestCol = col;
    }
  }
  
  return bestCol;
}

module.exports = { normalizePlate, spacedPlate, detectPlateColumn, detectCompanyColumn, detectModelColumn, detectPlateColumnFromData, VALID_LETTERS, LETTER_MAP };
