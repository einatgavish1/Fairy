// Reads the text out of a PDF or an image, then finds the invoice details in it.
// Everything runs in the browser: pdf.js for PDFs that carry text, Tesseract (Hebrew + English)
// for photos and scanned PDFs. Nothing is sent to an outside service.

const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/";
const TESSERACT = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";

function loadScript(src) {
  return new Promise((ok, bad) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = ok;
    s.onerror = () => bad(new Error("לא הצלחתי לטעון רכיב: " + src));
    document.head.appendChild(s);
  });
}

let pdfjsReady, ocrReady, ocrProgress = null;
function pdfjs() {
  pdfjsReady ||= loadScript(PDFJS + "pdf.min.js").then(() => {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + "pdf.worker.min.js";
    return window.pdfjsLib;
  });
  return pdfjsReady;
}
function ocrWorker() {
  ocrReady ||= loadScript(TESSERACT).then(async () => {
    const w = await window.Tesseract.createWorker(["heb", "eng"], 1, { logger: (m) => ocrProgress?.(m) });
    await w.setParameters({ preserve_interword_spaces: "1" });
    return w;
  });
  return ocrReady;
}

// One worker reads one page at a time, so OCR jobs wait for each other.
let ocrQueue = Promise.resolve();
function ocr(canvas, onProgress) {
  const job = ocrQueue.then(async () => {
    const w = await ocrWorker();
    ocrProgress = (m) => { if (m.status === "recognizing text") onProgress(m.progress); };
    try { return (await w.recognize(canvas)).data.text; }
    finally { ocrProgress = null; }
  });
  ocrQueue = job.catch(() => {});
  return job;
}

// ---------- reading files ----------

// -> { text, preview (small JPEG data URL), ocr (bool) }. onProgress(0..1, label).
export async function readFile(file, onProgress = () => {}) {
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  return isPdf ? readPdf(file, onProgress) : readImage(file, onProgress);
}

async function readPdf(file, onProgress) {
  onProgress(0.05, "פותח את ה-PDF…");
  const lib = await pdfjs();
  const pdf = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = Math.min(pdf.numPages, 3);
  const lines = [];
  for (let p = 1; p <= pages; p++) {
    const page = await pdf.getPage(p);
    lines.push(...pdfLines((await page.getTextContent()).items));
  }
  const first = await renderPage(await pdf.getPage(1), 1100);
  const preview = toPreview(first);
  let text = fixVisualOrder(lines).join("\n");
  // A scan saved as PDF has (almost) no text: read the page pictures instead.
  if (text.replace(/[^\p{L}\d]/gu, "").length < 40) {
    const parts = [];
    for (let p = 1; p <= pages; p++) {
      const canvas = await renderPage(await pdf.getPage(p), 2200);
      parts.push(await ocr(canvas, (x) => onProgress(0.1 + 0.9 * ((p - 1 + x) / pages), `מזהה טקסט בעמוד ${p}…`)));
    }
    return { text: parts.join("\n"), preview, ocr: true };
  }
  onProgress(1, "");
  return { text, preview, ocr: false };
}

async function renderPage(page, width) {
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: Math.min(4, width / base.width) });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

async function readImage(file, onProgress) {
  onProgress(0.02, "טוען את התמונה…");
  const img = await loadImage(file);
  // Photos from a phone are big; ~2400px on the long side is plenty for reading.
  const canvas = drawScaled(img, 2400, true);
  const preview = toPreview(canvas);
  onProgress(0.05, "מכין את זיהוי הטקסט (בפעם הראשונה זה לוקח רגע)…");
  const text = await ocr(canvas, (x) => onProgress(0.05 + 0.95 * x, "מזהה טקסט…"));
  return { text, preview, ocr: true };
}

function loadImage(file) {
  return new Promise((ok, bad) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); ok(img); };
    img.onerror = () => { URL.revokeObjectURL(url); bad(new Error("הקובץ לא נפתח כתמונה (אולי HEIC? שמרו כ-JPG)")); };
    img.src = url;
  });
}

function drawScaled(src, maxSide, gray = false) {
  const w = src.naturalWidth || src.width, h = src.naturalHeight || src.height;
  const k = Math.min(1, maxSide / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * k);
  canvas.height = Math.round(h * k);
  const ctx = canvas.getContext("2d");
  if (gray) ctx.filter = "grayscale(1) contrast(1.25)";
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// A small JPEG to keep next to the record (Firestore documents are limited to 1MB).
function toPreview(canvas) {
  for (const [side, q] of [[1000, 0.7], [850, 0.55], [700, 0.45]]) {
    const url = drawScaled(canvas, side).toDataURL("image/jpeg", q);
    if (url.length < 600000) return url;
  }
  return "";
}

// pdf.js gives loose text pieces; put the ones at the same height together as lines.
function pdfLines(items) {
  const rows = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const x = it.transform[4], y = it.transform[5], h = it.height || Math.abs(it.transform[3]) || 8;
    let row = rows.find((r) => Math.abs(r.y - y) < Math.max(2, h * 0.5));
    if (!row) rows.push((row = { y, parts: [] }));
    row.parts.push({ x, s: it.str });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map((r) => r.parts);
}

const HEB = /[֐-׿]/;
const KEYWORDS = ["חשבונית", "קבלה", "תאריך", "לתשלום", "סכום", "מע\"מ", "מע״מ", "בע\"מ", "בע״מ", "סה\"כ", "סה״כ", "עוסק", "מספר", "לכבוד", "פירוט", "כמות", "מחיר"];
const reverse = (s) => [...s].reverse().join("");
// Re-reverse the runs that read left to right (numbers, dates, English) after flipping a line.
const unflipLtr = (s) => s.replace(/[0-9A-Za-z][0-9A-Za-z.,:/\-@%₪$ ]*[0-9A-Za-z%₪$]|[0-9A-Za-z]/g, reverse);
const hits = (text) => KEYWORDS.reduce((n, k) => n + text.split(k).length - 1, 0);

// Some PDFs store Hebrew in visual order (letters backwards). Detect that by the keywords and fix it;
// otherwise order every Hebrew line right to left.
function fixVisualOrder(rows) {
  const ltr = rows.map((parts) => [...parts].sort((a, b) => a.x - b.x).map((p) => p.s).join(" ").replace(/\s+/g, " ").trim());
  const flipped = ltr.map((l) => (HEB.test(l) ? unflipLtr(reverse(l)) : l));
  if (hits(flipped.join("\n")) > hits(ltr.join("\n"))) return flipped;
  return rows.map((parts) => {
    const rtl = parts.some((p) => HEB.test(p.s));
    return [...parts].sort((a, b) => (rtl ? b.x - a.x : a.x - b.x)).map((p) => p.s).join(" ").replace(/\s+/g, " ").trim();
  });
}

// ---------- finding the details ----------

export const CATEGORIES = [
  ["חשמל", /חברת\s*החשמל|צריכת\s*חשמל|חשבון\s*חשמל|electric/i],
  ["מים", /תאגיד\s*(?:ה)?מים|צריכת\s*מים|חשבון\s*מים|מקורות|מי\s+\S+\s+בע/],
  ["ארנונה", /ארנונה|עיריית|עירית|מועצה\s*(?:מקומית|אזורית)/],
  ["גז", /אמישראגז|סופרגז|פזגז|גז\s*ביתי|צריכת\s*גז/],
  ["תקשורת", /בזק|פרטנר|סלקום|הוט\s*(?:מובייל|טלקום|נט)|HOT|גולן\s*טלקום|אינטרנט|סלולר|טלפוניה|תקשורת|קווי|yes\s/i],
  ["רכב ודלק", /תחנת\s*דלק|סונול|דור\s*אלון|(?:^|\s)פז(?:\s|$)|\bTEN\b|תדלוק|בנזין|סולר|מוסך|צמיגים|ליסינג|כביש\s*6|טסט\s*לרכב/i],
  ["חניה ותחבורה", /חניה|חנייה|חניון|פנגו|סלופארק|רב[\s-]?קו|רכבת\s*ישראל|מונית|gett|uber/i],
  ["ביטוח", /ביטוח|insurance/i],
  ["שכירות", /שכירות|שכ["״]ד|שכר\s*דירה|\brent\b/i],
  ["תוכנה ומנויים", /מנוי|subscription|google|microsoft|adobe|zoom|apple\.com|תוכנה|software|amazon\s*web|openai|anthropic|wix|canva/i],
  ["ציוד משרדי", /ציוד\s*משרדי|כלי\s*כתיבה|דפוס|הדפסה|נייר|טונר|דיו|office\s*depot|קרביץ/i],
  ["מחשבים ואלקטרוניקה", /מחשב|\bKSP\b|באג\s*מולטי|אלקטרוניקה|computer|laptop|מדפסת/i],
  ["כיבוד ומסעדות", /מסעדה|קפה|ארוחה|כיבוד|פיצה|מאפה|restaurant|cafe|coffee|wolt|תן\s*ביס/i],
  ["סופרמרקט", /שופרסל|רמי\s*לוי|יוחננוף|ויקטורי|אושר\s*עד|מגה\s*בעיר|סופרמרקט|מינימרקט/],
  ["שירותים מקצועיים", /ייעוץ|יעוץ|עו["״]ד|עורך\s*דין|עורכי\s*דין|רואה\s*חשבון|רואי\s*חשבון|הנהלת\s*חשבונות|consult|legal/i],
  ["פרסום ושיווק", /פרסום|שיווק|קמפיין|facebook\s*ads|google\s*ads|meta\s*platforms/i],
  ["אחזקה ותיקונים", /תיקון|תחזוקה|אחזקה|שיפוץ|אינסטלציה|אינסטלטור|חשמלאי|ניקיון|הדברה/],
  ["נסיעות ולינה", /מלון|טיסה|אל\s*על|booking\.com|airbnb|hotel|flight/i],
  ["בריאות", /מרפאה|בית\s*מרקחת|סופר[\s-]?פארם|רופא|קופת\s*חולים|מכבי|כללית|מאוחדת|לאומית/],
  ["חינוך והשתלמויות", /קורס|השתלמות|הדרכה|סדנה|שכר\s*לימוד|course|training/i],
];
export const CATEGORY_NAMES = [...CATEGORIES.map(([n]) => n), "אחר"];

const Q = "[\"״'׳]?"; // the quote in סה"כ / מע"מ / בע"מ comes in several shapes
const VAT_RE = new RegExp(`מע${Q}מ|\\bvat\\b|\\btax\\b`, "i");
const TOTAL_KEYS = [
  [new RegExp(`סה${Q}כ\\s*לתשלום|סך\\s*הכל\\s*לתשלום|יתרה\\s*לתשלום|סכום\\s*לתשלום|total\\s*due|amount\\s*due|grand\\s*total|balance\\s*due`, "i"), 100],
  [new RegExp(`(?:סה${Q}כ|סך\\s*הכו?ל)\\s*(?:כולל|כ\\.)\\s*מע${Q}מ|total\\s*incl`, "i"), 90],
  [/לתשלום|שולם|סכום\s*ששולם|total\s*paid|amount\s*paid/i, 75],
  [new RegExp(`סה${Q}כ|סך\\s*הכל|סך\\s*הכול|\\btotal\\b`, "i"), 55],
  [/סכום|\bamount\b|\bsum\b/i, 30],
];
const MONTHS = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];
const MONTHS_EN = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function isoDate(d, m, y) {
  d = +d; m = +m; y = +y;
  if (y < 100) y += 2000;
  if (y < 2000 || y > 2099 || m < 1 || m > 12 || d < 1 || d > 31) return "";
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function datesIn(line) {
  const out = [];
  for (const m of line.matchAll(/(?<!\d)(\d{1,2})\s?[./-]\s?(\d{1,2})\s?[./-]\s?(\d{4}|\d{2})(?!\d)/g)) out.push(isoDate(m[1], m[2], m[3]));
  for (const m of line.matchAll(/(?<!\d)(20\d{2})[./-](\d{1,2})[./-](\d{1,2})(?!\d)/g)) out.push(isoDate(m[3], m[2], m[1]));
  for (const m of line.matchAll(/(\d{1,2})\s*(?:ב|ל)?(ינואר|פברואר|מרץ|מרס|אפריל|מאי|יוני|יולי|אוגוסט|ספטמבר|אוקטובר|נובמבר|דצמבר)\s*,?\s*(20\d{2})/g))
    out.push(isoDate(m[1], m[2] === "מרס" ? 3 : MONTHS.indexOf(m[2]) + 1, m[3]));
  for (const m of line.matchAll(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(20\d{2})|([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(20\d{2})/g)) {
    const mon = MONTHS_EN.indexOf((m[2] || m[4]).toLowerCase()) + 1;
    if (mon) out.push(m[1] ? isoDate(m[1], mon, m[3]) : isoDate(m[5], mon, m[6]));
  }
  return out.filter(Boolean);
}

// Money amounts in a line, after taking out dates, phone numbers, percentages and long ID numbers.
function amountsIn(line) {
  const clean = line
    .replace(/(?<!\d)\d{1,2}\s?[./-]\s?\d{1,2}\s?[./-]\s?\d{2,4}(?!\d)/g, " ")
    .replace(/(?<!\d)0\d{1,2}-?\d{3}-?\d{4}(?!\d)|(?<!\d)05\d-?\d{7}(?!\d)/g, " ")
    .replace(/\d+(?:\.\d+)?\s?%/g, " ");
  const out = [];
  for (const m of clean.matchAll(/-?(?<![\d.,])\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?(?![\d,])|-?(?<![\d.,])\d+(?:\.\d{1,2})?(?![\d.,]*\d)/g)) {
    const raw = m[0].replace(/,/g, "");
    if (!raw.includes(".") && raw.replace("-", "").length >= 7) continue; // IDs, account numbers
    const n = Math.abs(parseFloat(raw));
    if (n > 0 && n < 10000000) out.push({ n, dec: raw.includes(".") });
  }
  return out;
}

// "סה"כ כולל מע"מ 177" is the total; a bare "כולל מע"מ 27" is the VAT inside it.
const GROSS_RE = new RegExp(`סה${Q}כ|סך\\s*הכו?ל|לתשלום|\\btotal\\b`, "i");
const isGrossLine = (line) => GROSS_RE.test(line);

function findTotal(lines) {
  let best = null;
  lines.forEach((line, i) => {
    let score = 0;
    for (const [re, s] of TOTAL_KEYS) if (re.test(line)) { score = s; break; }
    if (!score) return;
    if (VAT_RE.test(line) && !isGrossLine(line)) return;
    if (/לפני|ללא|בלי|before|excl|net/i.test(line)) score = 20;
    // The number is sometimes on the next line (two-column receipts).
    let nums = amountsIn(line);
    if (!nums.length && lines[i + 1]) nums = amountsIn(lines[i + 1]);
    if (!nums.length) return;
    const n = Math.max(...nums.map((x) => x.n));
    // Prefer decimals, a stronger keyword, and lines lower on the page (totals come last).
    const rank = score + (nums.some((x) => x.dec) ? 8 : 0) + i / lines.length * 5;
    if (!best || rank > best.rank || (rank === best.rank && n > best.n)) best = { n, rank };
  });
  if (best) return best.n;
  const all = lines.flatMap(amountsIn).filter((x) => x.dec);
  return all.length ? Math.max(...all.map((x) => x.n)) : null;
}

function findVat(lines, total) {
  let vat = null;
  for (const line of lines) {
    if (!VAT_RE.test(line) || isGrossLine(line) || /לפני|ללא|before|excl/i.test(line)) continue;
    const nums = amountsIn(line).filter((x) => !total || x.n < total * 0.5);
    const pick = nums.find((x) => x.dec) || nums[nums.length - 1];
    if (pick) vat = pick.n;
  }
  return vat;
}

function findDate(lines) {
  let best = null;
  lines.forEach((line, i) => {
    const ds = datesIn(line);
    if (!ds.length) return;
    let score = 10 - Math.min(i, 9); // earlier in the document is more likely the document date
    if (/תאריך|date|הופק|מועד/i.test(line)) score += 20;
    if (/פירעון|ערך|תפוגה|לידה|אספקה|due|valid|expir/i.test(line)) score -= 25;
    if (!best || score > best.score) best = { d: ds[0], score };
  });
  return best?.d || "";
}

const ID_RE = new RegExp(`(?:ח${Q}\\.?\\s?פ|ע${Q}\\.?\\s?מ|עוסק\\s*מורשה|עוסק\\s*פטור|מס['׳]?\\s*עוסק|מספר\\s*עוסק|ת\\.?\\s?ז|vat\\s*(?:no|id|number)|company\\s*(?:no|id))\\D{0,14}(\\d{8,9})`, "i");
const DOC_TYPES = [
  [/זיכוי|credit\s*note/i, "חשבונית זיכוי"],
  [new RegExp(`חשבונית\\s*מס\\s*[/\\\\-]?\\s*קבלה|tax\\s*invoice\\s*[/-]?\\s*receipt`, "i"), "חשבונית מס קבלה"],
  [/חשבונית\s*מס|tax\s*invoice/i, "חשבונית מס"],
  [/חשבון\s*עסקה|proforma/i, "חשבון עסקה"],
  [/קבלה|receipt/i, "קבלה"],
  [/חשבונית|invoice/i, "חשבונית"],
];
export const DOC_TYPE_NAMES = ["חשבונית מס קבלה", "חשבונית מס", "קבלה", "חשבון עסקה", "חשבונית זיכוי", "חשבונית", "אחר"];

function findDocNo(text) {
  const res = [
    /(?:חשבונית(?:\s*מס)?(?:\s*[/-]?\s*קבלה)?|קבלה|חשבון\s*עסקה|זיכוי)\s*(?:מס(?:פר|['׳.י])?|#)?\s*:?\s*([A-Z]{0,3}-?\d{3,12})(?![\d./])/i,
    /מס(?:פר|['׳.])\s*(?:חשבונית|מסמך|קבלה|אסמכתא)\s*:?\s*([A-Z]{0,3}-?\d{3,12})/i,
    /(?:invoice|receipt|document)\s*(?:no\.?|number|#)\s*:?\s*([A-Z]{0,4}-?\d{3,12})/i,
    /אסמכתא\s*:?\s*(\d{3,12})/,
  ];
  for (const re of res) { const m = text.match(re); if (m) return m[1]; }
  return "";
}

const NOT_A_NAME = /חשבונית|קבלה|מקור|העתק|נאמן\s*למקור|תאריך|לכבוד|עמוד|דף\s*\d|page|invoice|receipt|copy|original|טלפון|טל['׳.:]|פקס|fax|tel|www\.|@|כתובת|רחוב|רח['׳]|ת\.?ד|מיקוד|לקוח|customer|bill\s*to/i;
const cleanName = (s) => s.replace(ID_RE, "").replace(/(\S)(בע["״']?מ)/, "$1 $2").replace(/[|_*•·]+/g, " ").replace(/\s+/g, " ").replace(/^[\s\-:.,]+|[\s\-:.,]+$/g, "").slice(0, 60);

function findSupplier(lines) {
  // A company name usually ends with בע"מ / Ltd.
  const co = new RegExp(`([^:|]{2,50}?\\s*בע${Q}מ|[A-Za-z0-9 .&'-]{2,50}?\\b(?:Ltd|LTD|Inc|LLC|GmbH)\\.?)`);
  for (const line of lines.slice(0, 25)) {
    if (/לכבוד|bill\s*to|customer/i.test(line)) continue;
    const m = line.match(co);
    if (m) {
      const name = cleanName(m[1].replace(/^.*?(?:שם\s*העסק|ספק|מאת)\s*:?\s*/, ""));
      if (name.replace(/בע.?מ/, "").trim().length >= 2) return name;
    }
  }
  // "שם העסק: ..." / "ספק: ..."
  for (const line of lines) {
    const m = line.match(/(?:שם\s*העסק|שם\s*הספק|ספק|מאת|from|vendor|seller)\s*:\s*(.{2,60})/i);
    if (m) return cleanName(m[1]);
  }
  // Otherwise the first real words at the top of the page.
  for (const line of lines.slice(0, 10)) {
    const letters = line.replace(/[^\p{L}]/gu, "");
    if (letters.length < 3 || NOT_A_NAME.test(line)) continue;
    if (line.replace(/[^\d]/g, "").length > letters.length) continue;
    return cleanName(line);
  }
  return "";
}

function findCategory(text, supplier) {
  let best = null;
  for (const [name, re] of CATEGORIES) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    const score = (text.match(g) || []).length + (supplier && re.test(supplier) ? 5 : 0);
    if (score && (!best || score > best.score)) best = { name, score };
  }
  return best?.name || "";
}

// The first line of the item table, as a short description of what was bought.
function findDetails(lines) {
  const i = lines.findIndex((l) => /תיאור|פירוט|פריט|שם\s*(?:ה)?מוצר|שירות|description|item/i.test(l));
  if (i < 0) return "";
  for (const line of lines.slice(i + 1, i + 5)) {
    const words = line.replace(/[\d.,₪$%]+/g, " ").replace(/\s+/g, " ").trim();
    if (words.replace(/[^\p{L}]/gu, "").length >= 3 && !TOTAL_KEYS.some(([re]) => re.test(line))) return words.slice(0, 80);
  }
  return "";
}

export function parseText(text) {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const total = findTotal(lines);
  const vat = findVat(lines, total);
  const supplier = findSupplier(lines);
  let docType = "";
  for (const [re, name] of DOC_TYPES) if (re.test(text)) { docType = name; break; }
  return {
    date: findDate(lines),
    amount: total,
    vat,
    supplier,
    supplierId: text.match(ID_RE)?.[1] || "",
    docType,
    docNo: findDocNo(text),
    category: findCategory(text, supplier),
    details: findDetails(lines),
  };
}
