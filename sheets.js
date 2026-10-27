// Excel and CSV files. A sheet that is a table of expenses (a credit-card statement, a list exported
// from bookkeeping) gives one record per row, its columns found by their headings; anything else is
// left to be read as one document, like a PDF.
// Uses SheetJS (window.XLSX), loaded by index.html.

export const SHEET_EXT = /\.(xlsx|xlsm|xls|csv|ods)$/i;

// CSV files from Israeli banks are often in the old Hebrew code page rather than UTF-8.
export async function readWorkbook(file) {
  const XLSX = window.XLSX;
  if (/\.csv$/i.test(file.name)) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { text = new TextDecoder("windows-1255").decode(bytes); }
    // raw: keep "05/09/2026" as text, to be read day-first here, instead of SheetJS's month-first guess.
    return XLSX.read(text.replace(/^﻿/, ""), { type: "string", raw: true });
  }
  return XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
}

// All the text of a workbook, row by row, for reading it as one document.
export function workbookText(wb) {
  return wb.SheetNames.map((n) => window.XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: "" })
    .map((row) => row.map(cellText).filter(Boolean).join(" ")).filter(Boolean).join("\n")).join("\n");
}

// Each field and the headings that name its column, best first. A column is used for one field only,
// and the fields are matched in this order (so "סכום כולל מע"מ" is the amount, not the VAT).
const COLUMNS = [
  ["date", [/תאריך\s*(?:ה)?(?:עסקה|חשבונית|מסמך|קבלה|רכישה)/, /תאריך|^date|transaction\s*date/i]],
  ["amount", [/סכום\s*(?:ה)?חיוב|סכום\s*(?:ב)?ש["״']?ח|סכום\s*כולל|סה["״']?כ|total|charged/i, /סכום|amount|^sum$|price/i]],
  ["supplier", [/שם\s*בית\s*(?:ה)?עסק|בית\s*(?:ה)?עסק|שם\s*(?:ה)?ספק|^ספק|merchant|vendor|supplier|payee/i, /שם\s*העסק|תיאור|פרטי\s*(?:ה)?עסקה|description/i]],
  ["supplierId", [/ח\.?\s?פ|ע\.?\s?מ|מספר\s*עוסק|vat\s*(?:id|no)|company\s*id/i]],
  ["docNo", [/אסמכתא|מס['׳.]?\s*(?:מסמך|חשבונית|קבלה)|מספר\s*(?:מסמך|חשבונית|קבלה)|invoice\s*(?:no|number|#)|reference|^ref/i]],
  ["customer", [/^\s*לקוח|שם\s*(?:ה)?לקוח|customer|client/i]],
  ["docType", [/סוג\s*(?:ה)?מסמך|document\s*type/i]],
  ["category", [/ענף|קטגוריה|סוג\s*(?:ה)?(?:שירות|הוצאה)|category/i]],
  ["vat", [/^\s*(?:סכום\s*)?מע["״']?מ\s*$|^\s*vat\s*$/i]],
  ["details", [/הערות|פירוט|notes|memo/i]],
];

// The heading row (within the first 30) and which column holds what; null when there is no table.
function findHeader(grid) {
  for (let r = 0; r < Math.min(grid.length, 30); r++) {
    const cells = grid[r].map((c) => (typeof c === "string" ? c.trim() : ""));
    if (cells.filter(Boolean).length < 2) continue;
    const map = {}, used = new Set();
    for (const [field, patterns] of COLUMNS) {
      for (const re of patterns) {
        const c = cells.findIndex((h, i) => h && !used.has(i) && re.test(h));
        if (c >= 0) { map[field] = c; used.add(c); break; }
      }
    }
    if (map.date != null && map.amount != null && (map.supplier != null || map.details != null)) return { r, map };
  }
  return null;
}

function toIso(d) {
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}
// A Date, an Excel day number or "15/09/2026", "15.9.26", "2026-09-15" -> "2026-09-15" ("" when not a date).
function cellDate(v) {
  if (v instanceof Date && !isNaN(v)) return toIso(v);
  if (typeof v === "number" && v > 20000 && v < 80000) return toIso(new Date(Math.round((v - 25569) * 864e5)));
  const s = String(v ?? "").trim();
  let m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})(?!\d)/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    if (+m[2] >= 1 && +m[2] <= 12 && +m[1] >= 1 && +m[1] <= 31) return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : "";
}
// 1234.5, "₪1,234.50", "(12.00)", "-12" -> a number (null when empty or not a number).
function cellAmount(v) {
  if (typeof v === "number") return Math.round(v * 100) / 100;
  const s = String(v ?? "").trim();
  if (!s) return null;
  const neg = /^\(.*\)$/.test(s) || /^-|-$/.test(s);
  const n = parseFloat(s.replace(/[^\d.]/g, ""));
  return isNaN(n) ? null : Math.round((neg ? -n : n) * 100) / 100;
}
const cellText = (v) => (v instanceof Date ? toIso(v) : String(v ?? "")).replace(/\s+/g, " ").trim();

// -> [{ ref, date, amount, supplier, ... }] for every expense row of every sheet that is a table,
// or null when no sheet is one.
export function tableRows(wb) {
  const rows = [];
  let anyTable = false;
  for (const name of wb.SheetNames) {
    const grid = window.XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: "" });
    const head = findHeader(grid);
    if (!head) continue;
    anyTable = true;
    const { r: h, map } = head;
    for (let r = h + 1; r < grid.length; r++) {
      const row = grid[r];
      const get = (f) => (map[f] == null ? "" : row[map[f]]);
      const date = cellDate(get("date")), amount = cellAmount(get("amount"));
      // Without a supplier column, the description column says who it was.
      const supplier = cellText(get(map.supplier == null ? "details" : "supplier"));
      if (!date && amount == null) continue; // empty, a sub-heading or a total line
      if (!date && /סה["״']?כ|total/i.test(row.map(cellText).join(" "))) continue;
      rows.push({
        ref: `${wb.SheetNames.length > 1 ? `${name} › ` : ""}שורה ${r + 1}`,
        date, amount, supplier,
        supplierId: cellText(get("supplierId")).replace(/\D/g, ""),
        docNo: cellText(get("docNo")), customer: cellText(get("customer")),
        docType: cellText(get("docType")), category: cellText(get("category")),
        vat: cellAmount(get("vat")), details: map.supplier == null ? "" : cellText(get("details")),
      });
    }
  }
  return anyTable ? rows : null;
}
