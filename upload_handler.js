const XLSX = require('xlsx');
const { normalizePlate, spacedPlate } = require('./plate_parser');

// ── كلمات مفتاحية موحّدة (تُستخدم لاكتشاف الرأس ولاكتشاف الأعمدة) ──
const PLATE_KW = [
  'رقم اللوحة','رقم اللوحه','اللوحة','اللوحه','لوحة','لوحه','لوح','رقم المركبة','رقماللوحةمشبكه',
  'plate no. arabic','plate no arabic','plate no','plate number','plate_num','platenum',
  'license plate','license','bplate','plate',
];
const PLATE_KW_PRIORITY = ['رقماللوحةمشبكه','plate no. arabic','plate_num','plate number'];

const COMPANY_KW = [
  'شركة','شركه','بنك','جهة','جهه','الجهة','الشركة','البنك','والشركة','مالك','ممول','وكالة','وكاله',
  'company','bank','agency','financ','lender','owner','vendor','dealer','current branch',
];

const MODEL_KW_PRIORITY = [
  'طراز المركبة','صانع المركبة','نوع المركبة','vehicle name','car name',
  'astassets','طراز','صانع','ماركة','ماركه','نوع السيارة',
];
const MODEL_KW_GENERAL = [
  'موديل','الموديل','model','vehicle model','car type','brand','make',
  'الطراز','الماركة','النوع','نوع',
];
const MODEL_KW = [...MODEL_KW_PRIORITY, ...MODEL_KW_GENERAL];
const BAD_MODEL_KW = ['نوع الشهادة','نوع تسجيل','نوع الخدمة','شهادة','نوع تسجيل اللوحة','نوع البطاقة'];

const ALL_HEADER_KW = [...PLATE_KW, ...COMPANY_KW, ...MODEL_KW].map(k => k.toLowerCase());

// ── مساعدات ─────────────────────────────────────────────────────

// هل هذه القيمة تبدو كلوحة حقيقية (فيها حروف + أرقام)، لا مجرد كلمة رأس؟
function looksLikePlateValue(cellVal) {
  const s = String(cellVal || '').trim();
  if (!s) return false;
  const norm = normalizePlate(s);
  if (!norm) return false;
  // لازم فيها أرقام (رقم اللوحة)، وطول معقول
  return /\d/.test(norm) && norm.length >= 4 && norm.length <= 8;
}

// عدد الخلايا اللي تبدو لوحات صالحة ضمن صف واحد
function countPlateLikeCells(row) {
  if (!row) return 0;
  let c = 0;
  for (const cell of row) if (looksLikePlateValue(cell)) c++;
  return c;
}

// هل هذا الصف يحتوي كلمة مفتاحية معروفة (رأس محتمل)؟
function scoreHeaderRow(row) {
  if (!row) return 0;
  let score = 0;
  for (const cell of row) {
    const s = String(cell || '').trim().toLowerCase();
    if (!s) continue;
    if (ALL_HEADER_KW.some(k => s.includes(k))) score++;
  }
  return score;
}

// عدد اللوحات الصالحة ضمن عينة من الصفوف (لتقييم شيت/عمود)
function countValidPlatesInSample(rows, sampleSize = 50) {
  let count = 0;
  const n = Math.min(rows.length, sampleSize);
  for (let i = 0; i < n; i++) {
    const row = rows[i];
    if (!row) continue;
    for (const cell of row) {
      if (looksLikePlateValue(cell)) { count++; break; } // خلية وحدة تكفي لعدّ الصف
    }
  }
  return count;
}

// ── اختيار أفضل شيت (مو بس الأول) ──────────────────────────────
function pickBestSheet(workbook) {
  let bestName = workbook.SheetNames[0];
  let bestRows = null;
  let bestScore = -1;

  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false, raw: false });
    if (!rows || rows.length === 0) continue;
    const score = countValidPlatesInSample(rows, 100);
    if (score > bestScore) {
      bestScore = score;
      bestName = name;
      bestRows = rows;
    }
  }

  if (bestRows === null) {
    // كل الشيتات فاضية أو ما فيها لوحات — استخدم الأول كما هو
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    bestRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false, raw: false }) || [];
  }

  return { sheetName: bestName, rows: bestRows };
}

// ── البحث عن صف الرأس ضمن أول عدة صفوف (مو بس الصف الأول) ──────
function findHeaderRow(rows, maxScan = 8) {
  let bestIdx = -1;
  let bestScore = 0;

  const n = Math.min(rows.length, maxScan);
  for (let i = 0; i < n; i++) {
    const row = rows[i];
    if (!row) continue;
    const kwScore = scoreHeaderRow(row);
    const plateLikeScore = countPlateLikeCells(row);
    // صف فيه كلمات مفتاحية ومافيه لوحات حقيقية = رأس محتمل قوي
    if (kwScore > 0 && plateLikeScore === 0 && kwScore > bestScore) {
      bestScore = kwScore;
      bestIdx = i;
    }
  }
  return bestIdx; // -1 يعني ما فيه رأس واضح ضمن النطاق
}

function processExcelBuffer(buffer, portfolioName = '') {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellText: true, raw: false });

  const { sheetName, rows: rawRows } = pickBestSheet(workbook);

  if (!rawRows || rawRows.length === 0) {
    return { plates: [], errors: [], sheet: sheetName, total: 0 };
  }

  let dataStart = 0;
  let plateCol = 0;
  let companyCol = -1;
  let modelCol = -1;
  let headers = [];

  const headerRowIdx = findHeaderRow(rawRows);

  if (headerRowIdx >= 0) {
    dataStart = headerRowIdx + 1;
    headers = rawRows[headerRowIdx].map(h => String(h || '').trim());
    const headersLower = headers.map(h => h.toLowerCase());

    // اكتشاف عمود اللوحة — بالأولوية أولاً
    let plateColFound = headersLower.findIndex(h => PLATE_KW_PRIORITY.some(k => h.includes(k.toLowerCase())));
    if (plateColFound < 0) {
      plateColFound = headersLower.findIndex(h => PLATE_KW.some(k => h.includes(k.toLowerCase())));
    }
    plateCol = plateColFound >= 0 ? plateColFound : 0;

    // اكتشاف عمود الشركة عبر الكلمات المفتاحية
    companyCol = headersLower.findIndex(h => COMPANY_KW.some(k => h.includes(k.toLowerCase())));
    // إن ما لقينا، جرّب: عمود رأسه فيه رقم جوال طويل (يدل على اسم شركة + جوال كرأس ثابت)
    if (companyCol < 0) {
      companyCol = headers.findIndex(h => /\d{7,}/.test(h));
    }

    // اكتشاف عمود الموديل
    modelCol = headersLower.findIndex(h =>
      MODEL_KW.some(k => h.includes(k.toLowerCase())) &&
      !BAD_MODEL_KW.some(k => h.includes(k.toLowerCase()))
    );
  } else {
    // بدون رأس — اكتشف عمود اللوحة من البيانات
    dataStart = 0;
    const firstRow = rawRows[0] || [];
    let bestCol = 0;
    let bestScore = -1;
    const sample = Math.min(rawRows.length, 30);
    const colCount = Math.min(firstRow.length, 10);

    for (let col = 0; col < colCount; col++) {
      let score = 0;
      for (let row = 0; row < sample; row++) {
        const val = (rawRows[row] || [])[col];
        if (looksLikePlateValue(val)) score++;
      }
      if (score > bestScore) { bestScore = score; bestCol = col; }
    }
    plateCol = bestCol;

    // اكتشاف الشركة: عمود بقيمة متكررة (تباين منخفض) وليس اللوحة أو رقم هيكل (VIN)
    const vinLikeCols = new Set();
    if (colCount > 1) {
      let bestCompanyCol = -1;
      let bestRepeatScore = -1;
      for (let col = 0; col < colCount; col++) {
        if (col === plateCol) continue;
        const vals = [];
        for (let row = 0; row < sample; row++) {
          const v = String((rawRows[row] || [])[col] || '').trim();
          if (v) vals.push(v);
        }
        if (vals.length === 0) continue;
        // استبعاد أعمدة تشبه رقم الهيكل (VIN ~ 11-17 حرف/رقم فريد لكل صف)
        const looksLikeVin = vals.every(v => /^[A-Za-z0-9]{11,17}$/.test(v));
        if (looksLikeVin) { vinLikeCols.add(col); continue; }
        const uniqueCount = new Set(vals).size;
        // كلما قلّت القيم الفريدة (تكرار أكثر) كان عمود مرشح أقوى للشركة
        const repeatScore = vals.length - uniqueCount;
        if (repeatScore > bestRepeatScore) {
          bestRepeatScore = repeatScore;
          bestCompanyCol = col;
        }
      }
      companyCol = bestCompanyCol;

      // اكتشاف الموديل: أول عمود نصي متبقي (مو اللوحة، مو الشركة، مو VIN)
      for (let col = 0; col < colCount; col++) {
        if (col === plateCol || col === companyCol || vinLikeCols.has(col)) continue;
        let hasText = false;
        for (let row = 0; row < sample; row++) {
          const v = String((rawRows[row] || [])[col] || '').trim();
          if (v) { hasText = true; break; }
        }
        if (hasText) { modelCol = col; break; }
      }
    }
  }

  const plates = [];
  const errors = [];

  for (let i = dataStart; i < rawRows.length; i++) {
    const row = rawRows[i];
    if (!row || row.length === 0) continue;

    const rawPlate = String(row[plateCol] || '').trim();
    if (!rawPlate) continue; // صف فارغ — تجاهل بصمت

    const normalized = normalizePlate(rawPlate);
    // لازم تحتوي أرقام فعلياً — لوحة بدون أرقام (نص عربي عادي) مو لوحة حقيقية
    if (!normalized || normalized.length < 3 || !/\d/.test(normalized)) {
      if (rawPlate.length > 0) {
        errors.push({ row: i + 1, raw: rawPlate, reason: 'لوحة غير صالحة' });
      }
      continue;
    }

    const company = companyCol >= 0 ? String(row[companyCol] || '').trim() : '';

    // دمج صانع + طراز المركبة إذا كانا منفصلين (فقط لما عندنا رأس فعلي)
    let model = '';
    if (modelCol >= 0) {
      if (headers.length) {
        const headersLower = headers.map(h => (h || '').toLowerCase());
        const makerIdx = headersLower.findIndex(h => h.includes('صانع') || h.includes('astassets'));
        const typeIdx  = headersLower.findIndex(h => h.includes('طراز') || h.includes('vehicle name') || h.includes('car name'));
        const makerVal = makerIdx >= 0 ? String(row[makerIdx] || '').trim() : '';
        const typeVal  = typeIdx  >= 0 ? String(row[typeIdx]  || '').trim() : '';
        if (makerVal && typeVal && makerIdx !== typeIdx) {
          model = makerVal + ' - ' + typeVal;
        } else if (makerVal) {
          model = makerVal;
        } else if (typeVal) {
          model = typeVal;
        } else {
          model = String(row[modelCol] || '').trim();
        }
      } else {
        model = String(row[modelCol] || '').trim();
      }
    }

    plates.push({
      plate:        normalized,
      plate_spaced: spacedPlate(normalized),
      original:     rawPlate,
      company:      company || portfolioName,
      model:        model   || null,
      reason:       null,
    });
  }

  // إزالة المكررات
  const seen = new Set();
  const unique = plates.filter(p => {
    if (seen.has(p.plate)) return false;
    seen.add(p.plate);
    return true;
  });

  return {
    plates:  unique,
    all:     unique,
    preview: unique.slice(0, 20),
    errors,
    sheet:   sheetName,
    total:   unique.length,
  };
}

module.exports = { processExcelBuffer };
