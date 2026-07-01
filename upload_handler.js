const XLSX = require('xlsx');
const { normalizePlate, spacedPlate } = require('./plate_parser');

function processExcelBuffer(buffer, portfolioName = '') {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellText: true, raw: false });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  // قراءة كمصفوفة صفوف
  const rawRows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: '',
    blankrows: false,
    raw: false,
  });

  if (!rawRows || rawRows.length === 0) {
    return { plates: [], errors: [], sheet: sheetName, total: 0 };
  }

  // اكتشاف الرأس — أول صف فيه نص عربي غير رقمي
  let dataStart = 0;
  let plateCol = 0;
  let companyCol = -1;
  let modelCol = -1;

  const firstRow = rawRows[0];
  const isHeader = firstRow.some(cell => {
    const s = String(cell || '').trim();
    return s.length > 0 && /[\u0600-\u06FF]/.test(s) && !/^\d+$/.test(s);
  });

  if (isHeader) {
    dataStart = 1;
    const headers = firstRow.map(h => String(h || '').trim());

    // اكتشاف عمود اللوحة
    const plateKw = ['لوحة','لوحه','رقم','plate','لوح','اللوحة','اللوحه','رقم اللوحة','رقم اللوحه'];
    plateCol = headers.findIndex(h => plateKw.some(k => h.includes(k)));
    if (plateCol < 0) plateCol = 0; // افتراضي: أول عمود

    // اكتشاف عمود الشركة
    const companyKw = ['شركة','شركه','بنك','جهة','جهه','company','bank','الجهة','الشركة'];
    companyCol = headers.findIndex(h => companyKw.some(k => h.includes(k)));

    // اكتشاف عمود الموديل
    const modelKw = ['موديل','نوع','model','type','الموديل','النوع'];
    modelCol = headers.findIndex(h => modelKw.some(k => h.includes(k)));
  } else {
    // بدون رأس — اكتشف عمود اللوحة من البيانات
    let bestCol = 0;
    let bestScore = -1;
    const sample = Math.min(rawRows.length, 30);
    for (let col = 0; col < Math.min((firstRow || []).length, 8); col++) {
      let score = 0;
      for (let row = 0; row < sample; row++) {
        const val = String((rawRows[row] || [])[col] || '').trim();
        if (val && normalizePlate(val)) score++;
      }
      if (score > bestScore) { bestScore = score; bestCol = col; }
    }
    plateCol = bestCol;
  }

  const plates = [];
  const errors = [];

  for (let i = dataStart; i < rawRows.length; i++) {
    const row = rawRows[i];
    if (!row || row.length === 0) continue;

    const rawPlate = String(row[plateCol] || '').trim();
    if (!rawPlate) continue; // صف فارغ — تجاهل بصمت

    const normalized = normalizePlate(rawPlate);
    if (!normalized || normalized.length < 3) {
      if (rawPlate.length > 0) {
        errors.push({ row: i + 1, raw: rawPlate, reason: 'لوحة غير صالحة' });
      }
      continue;
    }

    const company = companyCol >= 0 ? String(row[companyCol] || '').trim() : '';
    const model   = modelCol   >= 0 ? String(row[modelCol]   || '').trim() : '';

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
