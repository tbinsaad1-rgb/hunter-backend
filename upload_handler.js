// ── معالج رفع ملفات الإكسل ───────────────────────────────────────
const XLSX = require('xlsx');
const { parsePlate, detectColumns, detectPlateColumnFromData, looksLikePlate } = require('./plate_parser');

function processExcelBuffer(buffer, companyName = '') {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const wsName = wb.SheetNames[0];
  const ws = wb.Sheets[wsName];
  const allRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  if (allRows.length < 1) throw new Error('الملف فارغ');

  // ─ محاولة ١: هيدر في الصف الأول ─────────────────────────────
  const firstRow = allRows[0].map(c => c ? String(c).trim() : '');
  let { plateCol, modelCol, companyCol } = detectColumns(firstRow);
  let dataStart = 1;

  // ─ محاولة ٢: إذا الصف الأول نفسه يبدو بيانات (بلا headers) ──
  if (plateCol === -1) {
    const allData = allRows;
    plateCol = detectPlateColumnFromData(allData);
    // ابحث عن عمود النوع (ثاني عمود غالباً)
    modelCol = plateCol === 0 ? 1 : 0;
    dataStart = 0;
    // إذا الصف الأول لا يحتوي لوحة، ابدأ من ١
    if (!looksLikePlate(allRows[0]?.[plateCol])) dataStart = 1;
  }

  const results = [];
  const errors  = [];
  const seen    = new Set();

  for (let i = dataStart; i < allRows.length; i++) {
    const row = allRows[i];
    if (!row || row.every(c => !c)) continue;

    const rawPlate = row[plateCol];
    if (!rawPlate) continue;

    const parsed = parsePlate(rawPlate);
    if (!parsed || !parsed.valid) {
      errors.push({ row: i + 1, value: rawPlate, reason: 'تعذّر قراءة اللوحة' });
      continue;
    }

    const plate = parsed.normalized;
    if (seen.has(plate)) continue;
    seen.add(plate);

    // استخراج النوع والشركة
    const model   = modelCol >= 0   ? (row[modelCol]   ? String(row[modelCol]).trim()   : null) : null;
    const company = companyCol >= 0 ? (row[companyCol] ? String(row[companyCol]).trim() : null) : (companyName || null);

    results.push({ plate, model, company, original: String(rawPlate).trim() });
  }

  return { plates: results, errors, total: allRows.length - dataStart, sheet: wsName };
}

module.exports = { processExcelBuffer };
