const XLSX = require('xlsx');
const { normalizePlate, spacedPlate, detectPlateColumn, detectCompanyColumn, detectModelColumn } = require('./plate_parser');

/**
 * معالجة ملف Excel وإرجاع قائمة اللوحات
 * - يتعرف على العمود تلقائياً
 * - يصحح الحروف
 * - يتجاهل الصفوف الفارغة بصمت
 * - لا يوقف الرفع بسبب صفوف سيئة
 */
function processExcelBuffer(buffer, portfolioName = '') {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellText: true, cellDates: false });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  
  // تحويل لمصفوفة
  const rawRows = XLSX.utils.sheet_to_json(sheet, { 
    header: 1, 
    defval: '',
    blankrows: false,
    raw: false,
  });
  
  if (!rawRows || rawRows.length === 0) {
    return { plates: [], errors: [], sheet: sheetName };
  }
  
  // اكتشاف الرأس
  let dataRows = rawRows;
  let plateCol = 0;
  let companyCol = -1;
  let modelCol = -1;
  let reasonCol = -1;
  
  // تحقق من أول صف — هل هو رأس؟
  const firstRow = rawRows[0];
  const hasHeader = firstRow.some(cell => 
    /[\u0600-\u06FF]/.test(String(cell)) && !/^[0-9]/.test(String(cell).trim())
  );
  
  if (hasHeader) {
    const headers = firstRow.map(h => String(h || '').trim());
    plateCol   = detectPlateColumn(headers);
    companyCol = detectCompanyColumn(headers);
    modelCol   = detectModelColumn(headers);
    
    // البحث عن عمود السبب
    const reasonKw = ['سبب','reason','ملاحظة','ملاحظه'];
    reasonCol = headers.findIndex(h => reasonKw.some(k => String(h).toLowerCase().includes(k)));
    
    dataRows = rawRows.slice(1); // تخطي الرأس
  } else {
    // بدون رأس — اكتشف عمود اللوحة من البيانات
    let bestCol = 0;
    let bestScore = -1;
    const sampleSize = Math.min(dataRows.length, 30);
    
    for (let col = 0; col < Math.min(firstRow.length, 8); col++) {
      let score = 0;
      for (let row = 0; row < sampleSize; row++) {
        const val = String(rawRows[row][col] || '').trim();
        if (val && normalizePlate(val)) score++;
      }
      if (score > bestScore) { bestScore = score; bestCol = col; }
    }
    plateCol = bestCol;
  }
  
  const plates = [];
  const errors = [];
  
  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    if (!row || row.length === 0) continue;
    
    const rawPlate = String(row[plateCol] || '').trim();
    if (!rawPlate) continue; // صف فارغ — تجاهل بصمت
    
    const normalized = normalizePlate(rawPlate);
    if (!normalized || normalized.length < 3) {
      // صف سيء — سجّله لكن لا توقف الرفع
      if (rawPlate.length > 0) {
        errors.push({ row: i + 2, raw: rawPlate, reason: 'لوحة غير صالحة' });
      }
      continue;
    }
    
    const company = companyCol >= 0 ? String(row[companyCol] || '').trim() : portfolioName;
    const model   = modelCol   >= 0 ? String(row[modelCol]   || '').trim() : '';
    const reason  = reasonCol  >= 0 ? String(row[reasonCol]  || '').trim() : '';
    
    plates.push({
      plate:    normalized,
      plate_spaced: spacedPlate(normalized),
      original: rawPlate,
      company:  company || portfolioName,
      model:    model   || null,
      reason:   reason  || null,
    });
  }
  
  return { plates, errors, sheet: sheetName, total: plates.length };
}

module.exports = { processExcelBuffer };
