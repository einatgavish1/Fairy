// The filing report (דוח להגשה) built from a comparative profit and loss report (דוח השוואתי): every
// account of the comparative report adds up into one line of the filing report, by its account code,
// in the layout of the tax-report workbook. The comparative report comes from the bookkeeping software
// (an Excel export) or is put together here from the documents in the system.

// The lines of the filing report and which account codes add up into each.
export const EXPENSE_LINES = [
  ["הוצאות מכירה ושיווק", (c) => /^60/.test(c)],
  ["דמי שכירות וארנונה", (c) => /^612/.test(c)],
  ["אחזקת משרד", (c) => /^613/.test(c)],
  ["מחשבים ותקשורת", (c) => /^614/.test(c)],
  ["שירותים מקצועיים", (c) => /^615/.test(c)],
  ["השתלמויות וספרות מקצועית", (c) => /^616/.test(c)],
  ["פחת", (c) => /^617/.test(c)],
  ["אחזקת רכב", (c) => /^618/.test(c)],
  ["כיבוד", (c) => c === "619010"],
  ["אחרות", (c) => /^6/.test(c)], // whatever expense the lines above did not take
];
const isIncome = (c) => /^4/.test(c);
const isStock = (c) => c === "501000" || c === "503000";
const isPurchase = (c) => /^5/.test(c) && !isStock(c);

const cellText = (v) => String(v ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
const num = (v) => (typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/[^\d.-]/g, "")) || 0);

// The comparative report of an Excel workbook (the sheet with the columns חשבון and סכום השנה):
// -> { year, lines: [{ section, code, name, cur, prev }] }, or null when the workbook has none.
export function parseComparative(wb) {
  const XLSX = window.XLSX;
  const names = [...wb.SheetNames].sort((a, b) => /השוואתי/.test(b) - /השוואתי/.test(a));
  for (const sheet of names) {
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, raw: true, defval: "" });
    const h = grid.findIndex((row) => row.some((c) => cellText(c) === "חשבון") && row.some((c) => /סכום\s*השנה/.test(cellText(c))));
    if (h < 0) continue;
    const head = grid[h].map(cellText);
    const col = (re) => head.findIndex((c) => re.test(c));
    const cSection = col(/סעיף/), cCode = head.indexOf("חשבון"), cName = col(/תאור|תיאור/);
    const cCur = col(/סכום\s*השנה/), cPrev = col(/שנה\s*שעברה|קודמת/);
    // The year from "נכון לתקופה: 31/12/2025-01/01/2025" above the table.
    const period = grid.slice(0, h).flat().map(cellText).join(" ");
    const year = (period.match(/(?:19|20)\d{2}/g) || []).pop() || "";
    const lines = [];
    let section = "";
    for (const row of grid.slice(h + 1)) {
      const s = cSection >= 0 ? cellText(row[cSection]) : "";
      if (s && !/^סה["״]?כ/.test(s)) section = s;
      const code = cellText(row[cCode]).replace(/\.0+$/, "");
      if (!/^\d{5,7}$/.test(code)) continue;
      lines.push({ section, code, name: cName >= 0 ? cellText(row[cName]) : "", cur: num(row[cCur]), prev: cPrev >= 0 ? num(row[cPrev]) : 0 });
    }
    if (lines.length) return { year, lines };
  }
  return null;
}

// A comparative report put together from the documents: each account's total this year and last year.
// docs are the client's documents; accountOf and accountName come from accounts.js.
export function comparativeFromDocs(docs, year, accountOf, accountName) {
  const by = new Map();
  for (const r of docs) {
    const y = (r.date || "").slice(0, 4);
    if (y !== String(year) && y !== String(year - 1)) continue;
    const code = accountOf(r);
    if (/^15/.test(code)) continue; // a fixed asset bought is not an expense of the year (its depreciation is)
    const line = by.get(code) || { section: lineOf(code), code, name: accountName(code), cur: 0, prev: 0 };
    line[y === String(year) ? "cur" : "prev"] += r.amount || 0;
    by.set(code, line);
  }
  return [...by.values()].map((l) => ({ ...l, cur: round2(l.cur), prev: round2(l.prev) })).sort((a, b) => a.code.localeCompare(b.code));
}
const round2 = (n) => Math.round(n * 100) / 100;

// The filing report line an account code adds up into.
export function lineOf(code) {
  if (isIncome(code)) return "הכנסות";
  if (isStock(code)) return "שינויים במלאי";
  if (isPurchase(code)) return "קניות אחרות";
  return (EXPENSE_LINES.find(([, test]) => test(code)) || ["אחרות"])[0];
}

// The figures of the filing report, each line rounded to whole shekels as in the workbook.
// field: "cur" for this year, "prev" for last year.
export function buildFiling(lines, { carPct = 55, mealPct = 20 } = {}, field = "cur") {
  const sum = (test) => Math.round(lines.filter((l) => test(l.code)).reduce((s, l) => s + (l[field] || 0), 0));
  const income = sum(isIncome);
  const stock = sum((c) => c === "501000") - sum((c) => c === "503000");
  const purchases = sum(isPurchase);
  const cost = stock + purchases;
  const gross = income - cost;
  const taken = new Set();
  const expenses = EXPENSE_LINES.map(([label, test]) => {
    const value = Math.round(lines.filter((l) => !taken.has(l.code) && /^6/.test(l.code) && test(l.code))
      .reduce((s, l) => { taken.add(l.code); return s + (l[field] || 0); }, 0));
    return [label, value];
  });
  const expenseTotal = expenses.reduce((s, [, v]) => s + v, 0);
  const result = gross - expenseTotal;
  const value = (label) => expenses.find(([l]) => l === label)[1];
  const carAdj = value("אחזקת רכב") * carPct / 100;
  const mealAdj = value("כיבוד") * mealPct / 100;
  return { income, stock, purchases, cost, gross, expenses, expenseTotal, result, carAdj, mealAdj, adjTotal: carAdj + mealAdj, final: result + carAdj + mealAdj };
}

// The workbook's own number format: thousands, no decimals, a dash for nothing.
const NUM = '_ * #,##0_ ;_ * \\-#,##0_ ;_ * "-"??_ ;_ @_ ';
const RESULT = "#,##0;\\(#,##0\\)";

// The filing report as an Excel sheet laid out like the workbook's "דוח להגשה", with its formulas.
export function filingSheet(data) {
  const XLSX = window.XLSX;
  const { client, idNumber, fileNo, year, carPct, mealPct, f } = data;
  const ws = {};
  const put = (ref, v, z) => {
    if (v === "" || v == null) return;
    ws[ref] = typeof v === "number" ? { t: "n", v, z } : { t: "s", v };
  };
  const formula = (ref, f2, v, z) => (ws[ref] = { t: "n", f: f2, v, z });
  put("A1", `${client}   - תעודת זהות ${idNumber || ""}`);
  put("A2", `תיק מספר ${fileNo || ""}`);
  put("A3", `דוח הכנסות והוצאות לשנת המס ${year}`);
  put("B6", "שקלים חדשים"); put("D6", "שקלים חדשים");
  put("A9", "הכנסות"); put("D9", f.income, NUM);
  if (f.stock) { put("A12", "שינויים במלאי"); put("B12", f.stock, NUM); }
  put("A13", "קניות אחרות"); put("B13", f.purchases, NUM);
  put("A14", "עלות ההכנסות"); formula("D14", "SUM(B12:B13)", f.cost, NUM);
  put("A15", "רווח גולמי"); formula("D15", "+D9-D14", f.gross, NUM);
  put("A17", "הוצאות  מכירה הנהלה וכלליות");
  f.expenses.forEach(([label, v], i) => { put(`A${18 + i}`, label); if (v) put(`B${18 + i}`, v, NUM); });
  put("A28", " הוצאות מכירה הנהלה וכלליות"); formula("D28", "SUM(B17:B27)", f.expenseTotal, NUM);
  put("A29", f.result < 0 ? "הפסד לשנה" : "רווח לשנה"); formula("D29", "+D15-D28", f.result, RESULT);
  put("A31", "תאומים ");
  put("A32", "הוצאות רכב "); formula("B32", `+B25*${carPct / 100}`, f.carAdj, NUM);
  put("A33", "כיבודים"); formula("B33", `+B26*${mealPct / 100}`, f.mealAdj, NUM);
  formula("D34", "+B32+B33", f.adjTotal, NUM);
  put("A35", f.final < 0 ? `הפסד מעסק לשנת ${year} מקוזז מהכנסה משכר` : `רווח מעסק לשנת ${year}`);
  formula("D35", "+D29+D34", f.final, RESULT);
  ws["!ref"] = "A1:D35";
  ws["!merges"] = [0, 1, 2].map((r) => ({ s: { r, c: 0 }, e: { r, c: 3 } }));
  ws["!cols"] = [33, 15, 1.25, 15].map((wch) => ({ wch }));
  return ws;
}

// The comparative report it was built from, as a sheet like the workbook's "דוח השוואתי".
export function comparativeSheet({ year, lines }) {
  const XLSX = window.XLSX;
  const aoa = [["רווח והפסד השוואתי -ביאורים"], [`נכון לתקופה: 31/12/${year}-01/01/${year}`],
    ["סעיף רווח והפסד", "חשבון", "תאור חשבון", "סכום השנה", "סכום בשנה שעברה"]];
  let last = "";
  for (const l of lines) {
    aoa.push([l.section !== last ? l.section : "", +l.code, l.name, l.cur, l.prev]);
    last = l.section;
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  for (let r = 3; r < aoa.length; r++) for (const c of [3, 4]) {
    const cell = ws[XLSX.utils.encode_cell({ r, c })];
    if (cell) cell.z = "#,##0.00";
  }
  ws["!cols"] = [26, 9, 26, 13, 15].map((wch) => ({ wch }));
  return ws;
}
