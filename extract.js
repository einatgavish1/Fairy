// Reads the text out of a PDF, an image or a Word file, then finds the invoice details in it.
// Everything runs in the browser: pdf.js for PDFs that carry text, Tesseract (Hebrew + English)
// for photos and scans (HEIC and TIFF converted first), mammoth for .docx. Nothing is sent to an outside service.

import { SHEET_EXT, readWorkbook, workbookText } from "./sheets.js?v=1";

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

// What can be read, by extension (the upload filter in app.js uses these too).
export const READABLE = /\.(pdf|jpe?g|jfif|pjpeg|png|webp|gif|bmp|avif|heic|heif|tiff?|docx|xlsx|xlsm|xls|csv|ods)$/i;
export const MIME = {
  pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", jfif: "image/jpeg", pjpeg: "image/jpeg", png: "image/png",
  webp: "image/webp", gif: "image/gif", bmp: "image/bmp", avif: "image/avif", heic: "image/heic", heif: "image/heif",
  tif: "image/tiff", tiff: "image/tiff", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
  xls: "application/vnd.ms-excel", csv: "text/csv", ods: "application/vnd.oasis.opendocument.spreadsheet",
};
const HEIC2ANY = "https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js";
const PAKO = "https://cdn.jsdelivr.net/npm/pako@1.0.11/dist/pako.min.js";
const UTIF = "https://cdn.jsdelivr.net/npm/utif@3.1.0/UTIF.js";
const MAMMOTH = "https://cdn.jsdelivr.net/npm/mammoth@1.6.0/mammoth.browser.min.js";
const loaded = {};
const loadOnce = (src) => (loaded[src] ||= loadScript(src));

function kindOf(file) {
  const ext = (file.name.match(/\.([^.]+)$/)?.[1] || "").toLowerCase();
  if (ext === "pdf" || file.type === "application/pdf") return "pdf";
  if (/^hei[cf]$/.test(ext) || /hei[cf]/.test(file.type)) return "heic";
  if (/^tiff?$/.test(ext) || /tiff/.test(file.type)) return "tiff";
  if (ext === "docx" || /wordprocessingml/.test(file.type)) return "docx";
  if (SHEET_EXT.test(file.name)) return "sheet";
  return "image";
}

// -> { text, preview (small JPEG data URL), ocr (bool) }. onProgress(0..1, label).
// With a page number, only that page of a PDF is read (a file of many invoices, a document per page).
export async function readFile(file, onProgress = () => {}, page = 0) {
  switch (kindOf(file)) {
    case "pdf": return readPdf(file, onProgress, page);
    case "heic": return readHeic(file, onProgress);
    case "tiff": return readTiff(file, onProgress);
    case "docx": return readDocx(file, onProgress);
    case "sheet": return readSheet(file, onProgress);
    default: return readImage(file, onProgress);
  }
}

// iPhone photos: most browsers can't show HEIC, so it becomes a JPEG first.
async function readHeic(file, onProgress) {
  onProgress(0.02, "ממיר תמונת אייפון (HEIC)…");
  await loadOnce(HEIC2ANY);
  let jpeg;
  try { jpeg = await window.heic2any({ blob: file, toType: "image/jpeg", quality: 0.92 }); }
  catch { throw new Error("תמונת ה-HEIC פגומה או בגרסה שלא נתמכת. שמרו אותה כ-JPG"); }
  if (Array.isArray(jpeg)) jpeg = jpeg[0];
  return readImage(new File([jpeg], file.name.replace(/\.\w+$/, ".jpg"), { type: "image/jpeg" }), onProgress);
}

// Scanners often save TIFF, sometimes several pages in one file; the first three pages are read.
async function readTiff(file, onProgress) {
  onProgress(0.02, "פותח סריקת TIFF…");
  await loadOnce(PAKO);
  await loadOnce(UTIF);
  const buf = await file.arrayBuffer();
  const pages = window.UTIF.decode(buf).filter((ifd) => ifd.t256).slice(0, 3);
  if (!pages.length) throw new Error("קובץ ה-TIFF ריק או פגום");
  const parts = [];
  let preview = "";
  for (const [p, ifd] of pages.entries()) {
    window.UTIF.decodeImage(buf, ifd);
    const raw = document.createElement("canvas");
    raw.width = ifd.width;
    raw.height = ifd.height;
    raw.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(window.UTIF.toRGBA8(ifd).buffer), ifd.width, ifd.height), 0, 0);
    const canvas = drawScaled(raw, 2400, true);
    if (!p) preview = toPreview(canvas);
    parts.push(await ocr(canvas, (x) => onProgress((p + x) / pages.length, pages.length > 1 ? `מזהה טקסט בעמוד ${p + 1}…` : "מזהה טקסט…")));
  }
  return { text: parts.join("\n"), preview, ocr: true };
}

// Word (.docx): the text is in the file, no OCR needed. The preview is a plain picture of its first lines.
async function readDocx(file, onProgress) {
  onProgress(0.1, "קורא קובץ Word…");
  await loadOnce(MAMMOTH);
  const { value } = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  onProgress(1, "");
  return { text: value, preview: textPreview(value), ocr: false };
}

// A spreadsheet that is not a table of expenses (an invoice made in Excel, say): its text, as one document.
async function readSheet(file, onProgress) {
  onProgress(0.1, "קורא קובץ אקסל…");
  const text = workbookText(await readWorkbook(file));
  onProgress(1, "");
  return { text, preview: textPreview(text), ocr: false };
}

function textPreview(text) {
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean).slice(0, 38);
  const c = document.createElement("canvas");
  c.width = 800;
  c.height = 1060;
  const x = c.getContext("2d");
  x.fillStyle = "#fff";
  x.fillRect(0, 0, c.width, c.height);
  x.fillStyle = "#222";
  x.font = "22px Arial";
  x.direction = "rtl";
  x.textAlign = "right";
  lines.forEach((l, i) => x.fillText(l.slice(0, 70), 770, 44 + i * 27));
  return toPreview(c);
}

// The number of pages of a PDF; 1 for any other file.
export async function pageCount(file) {
  if (kindOf(file) !== "pdf") return 1;
  const lib = await pdfjs();
  const pdf = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
  const n = pdf.numPages;
  pdf.destroy();
  return n;
}

async function readPdf(file, onProgress, only = 0) {
  onProgress(0.05, "פותח את ה-PDF…");
  const lib = await pdfjs();
  const pdf = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
  // the first three pages, or the one page asked for
  const from = only || 1, pages = only ? 1 : Math.min(pdf.numPages, 3);
  const lines = [];
  for (let p = from; p < from + pages; p++) {
    const page = await pdf.getPage(p);
    lines.push(...pdfLines((await page.getTextContent()).items));
  }
  const first = await renderPage(await pdf.getPage(from), 1100);
  const preview = toPreview(first);
  let text = fixVisualOrder(lines).join("\n");
  // A scan saved as PDF has (almost) no text: read the page pictures instead.
  if (text.replace(/[^\p{L}\d]/gu, "").length < 40) {
    const parts = [];
    let firstPage = null;
    for (let p = from; p < from + pages; p++) {
      const canvas = await renderPage(await pdf.getPage(p), 2200);
      if (p === from) firstPage = canvas;
      parts.push(await ocr(canvas, (x) => onProgress(0.1 + 0.8 * ((p - from + x) / pages), `מזהה טקסט בעמוד ${p}…`)));
    }
    const scanned = parts.join("\n");
    return { text: scanned, alt: await secondReading(firstPage, scanned, onProgress), preview, ocr: true };
  }
  // A supplier is often known only by its logo (Gett, say), which is a picture, not text. When the text
  // doesn't tell the service, the top of the first page is read as a picture too, for the logo's words.
  let hint = "";
  if (!findCategory(text, "")) {
    try {
      const page = await renderPage(await pdf.getPage(from), 2200);
      const top = document.createElement("canvas");
      top.width = page.width;
      top.height = Math.round(page.height * 0.3);
      top.getContext("2d").drawImage(page, 0, 0);
      hint = await ocr(top, (x) => onProgress(0.6 + 0.4 * x, "מזהה את הלוגו…"));
    } catch { /* without the logo the details are still there */ }
  }
  onProgress(1, "");
  return { text, preview, ocr: false, hint };
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
  return readPicture(drawScaled(img, 2400, true), onProgress, null);
}

// Reads a picture of a document. turn: degrees to turn it first (clockwise), or null to find the way
// up by itself (see uprightTurn). -> { text, alt, preview (the picture as read, upright), ocr }
async function readPicture(canvas, onProgress, turn = null) {
  onProgress(0.05, "מכין את זיהוי הטקסט (בפעם הראשונה זה לוקח רגע)…");
  const deg = turn ?? await uprightTurn(canvas, onProgress);
  if (deg) canvas = rotate(canvas, deg);
  const text = await ocr(canvas, (x) => onProgress(0.3 + 0.5 * x, "מזהה טקסט…"));
  return { text, alt: await secondReading(canvas, text, onProgress), preview: toPreview(canvas), ocr: true, turned: deg };
}

// A receipt photographed lying on its side is wider than it is tall, and read that way its lines come
// out as noise. Such a picture is read small at a quarter turn each way too, and kept the way its text
// came out clearest. An upright (portrait) picture is taken as it is.
async function uprightTurn(canvas, onProgress) {
  if (canvas.width <= canvas.height * 1.15) return 0;
  const probe = drawScaled(canvas, 1400);
  let best = { deg: 0, score: -1 };
  for (const [i, deg] of [0, 90, 270].entries()) {
    const text = await ocr(rotate(probe, deg), (x) => onProgress(0.05 + 0.25 * ((i + x) / 3), "בודק באיזה כיוון המסמך…"));
    const score = clarity(text);
    if (score > best.score) best = { deg, score };
  }
  return best.deg;
}

// The picture turned by 90, 180 or 270 degrees clockwise.
export function rotate(src, deg) {
  deg = ((deg % 360) + 360) % 360;
  if (!deg) return src;
  const c = document.createElement("canvas");
  const side = deg === 90 || deg === 270;
  c.width = side ? src.height : src.width;
  c.height = side ? src.width : src.height;
  const x = c.getContext("2d");
  x.translate(c.width / 2, c.height / 2);
  x.rotate((deg * Math.PI) / 180);
  x.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

// The saved picture of a document (a data URL) turned clockwise, as a new data URL.
export async function rotatePreview(dataUrl, deg) {
  const img = await loadImage(dataUrl);
  return toPreview(rotate(drawScaled(img, 2000), deg));
}

// Reads a saved picture again: turned by deg, or turned the right way up by itself when deg is null.
export async function rereadPreview(dataUrl, deg = null, onProgress = () => {}) {
  const img = await loadImage(dataUrl);
  // The saved picture is small; enlarging it a little gives the reading more to work with.
  const k = Math.max(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.round(img.naturalWidth * k);
  c.height = Math.round(img.naturalHeight * k);
  const x = c.getContext("2d");
  x.imageSmoothingQuality = "high";
  x.filter = "grayscale(1) contrast(1.25)";
  x.drawImage(img, 0, 0, c.width, c.height);
  return readPicture(c, onProgress, deg);
}

// When the first reading of a picture misses the date, the amount or the supplier, the picture is read
// again in black and white: each pixel against the light around it, which brings out faint print on a
// shaded photo or a grey scan. parseText takes each detail from the clearer of the two readings.
async function secondReading(canvas, text, onProgress) {
  if (!canvas) return "";
  const first = parseOne(text);
  if (first.date && first.amount && first.supplier) return "";
  try { return await ocr(binarize(canvas), (x) => onProgress(0.8 + 0.2 * x, "קורא שוב בניגודיות גבוהה…")); }
  catch { return ""; }
}

// Adaptive threshold: a pixel is ink when it is darker than the mean of its neighbourhood (summed fast
// with an integral image); the picture is first brought to about 2200 pixels on its long side.
function binarize(src) {
  const k = 2200 / Math.max(src.width, src.height);
  const c = document.createElement("canvas");
  c.width = Math.round(src.width * k);
  c.height = Math.round(src.height * k);
  const x = c.getContext("2d");
  x.imageSmoothingQuality = "high";
  x.filter = "grayscale(1)";
  x.drawImage(src, 0, 0, c.width, c.height);
  const W = c.width, H = c.height, img = x.getImageData(0, 0, W, H), p = img.data;
  const sum = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let i = 0; i < W; i++) { row += p[(y * W + i) * 4]; sum[(y + 1) * (W + 1) + i + 1] = sum[y * (W + 1) + i + 1] + row; }
  }
  const r = Math.round(Math.max(W, H) / 60);
  for (let y = 0; y < H; y++) for (let i = 0; i < W; i++) {
    const x0 = Math.max(0, i - r), x1 = Math.min(W - 1, i + r), y0 = Math.max(0, y - r), y1 = Math.min(H - 1, y + r);
    const mean = (sum[(y1 + 1) * (W + 1) + x1 + 1] - sum[y0 * (W + 1) + x1 + 1] - sum[(y1 + 1) * (W + 1) + x0] + sum[y0 * (W + 1) + x0])
      / ((x1 - x0 + 1) * (y1 - y0 + 1));
    const v = p[(y * W + i) * 4] < mean * 0.88 ? 0 : 255;
    p[(y * W + i) * 4] = p[(y * W + i) * 4 + 1] = p[(y * W + i) * 4 + 2] = v;
  }
  x.putImageData(img, 0, 0);
  return c;
}

// A File, or a picture already in memory as a data URL.
function loadImage(file) {
  return new Promise((ok, bad) => {
    const own = typeof file !== "string";
    const url = own ? URL.createObjectURL(file) : file;
    const img = new Image();
    img.onload = () => { if (own) URL.revokeObjectURL(url); ok(img); };
    img.onerror = () => { if (own) URL.revokeObjectURL(url); bad(new Error("הקובץ לא נפתח כתמונה (ייתכן שהוא פגום)")); };
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

// A JPEG to keep next to the record (Firestore documents are limited to 1MB). It is kept large enough
// to be read again later (a receipt photographed on its side has small print), smaller only when it must.
function toPreview(canvas) {
  for (const [side, q] of [[1800, 0.72], [1500, 0.62], [1200, 0.55], [1000, 0.5], [800, 0.45]]) {
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
    row.parts.push({ x, w: it.width || 0, h, s: it.str });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map((r) => r.parts);
}

// Puts a line's pieces together in reading order. Some PDFs (Gett receipts, for one) set every letter
// as its own piece, so a space goes in only where there is a real gap between two pieces, not
// between any two of them ("ג'יטי", not "ג ' י ט י").
function joinParts(parts, rtl) {
  const sorted = [...parts].sort((a, b) => (rtl ? b.x - a.x : a.x - b.x));
  let out = "";
  sorted.forEach((p, i) => {
    const prev = sorted[i - 1];
    if (prev) {
      const gap = rtl ? prev.x - (p.x + p.w) : p.x - (prev.x + prev.w);
      if (!p.w || !prev.w || gap > Math.min(p.h, prev.h) * 0.18) out += " ";
    }
    out += p.s;
  });
  return out.replace(/\s+/g, " ").trim();
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
  const ltr = rows.map((parts) => joinParts(parts, false));
  const flipped = ltr.map((l) => (HEB.test(l) ? unflipLtr(reverse(l)) : l));
  if (hits(flipped.join("\n")) > hits(ltr.join("\n"))) return flipped;
  return rows.map((parts) => joinParts(parts, parts.some((p) => HEB.test(p.s))));
}

// ---------- finding the details ----------

export const CATEGORIES = [
  // a receipt for a donation (to a public institution, often "לעניין סעיף 46") - kept apart from expenses
  ["תרומות", /תרומה|תרומות|תרומתך|תרומתכם|סעיף\s*46|סעיף\s*46\s*א/],
  ["חשמל", /חברת\s*החשמל|צריכת\s*חשמל|חשבון\s*חשמל|electric/i],
  ["מים", /תאגיד\s*(?:ה)?מים|צריכת\s*מים|חשבון\s*מים|מקורות|מי\s+\S+\s+בע|(?:^|\s)מים(?:\s|$)|מי\s*אביבים|הגיחון|מי\s*רעננה|מי\s*שבע|מי\s*כרמל|מי\s*מודיעין/],
  ["ארנונה", /ארנונה|עיריית|עירית|מועצה\s*(?:מקומית|אזורית)/],
  ["גז", /אמישראגז|סופרגז|פזגז|גז\s*ביתי|צריכת\s*גז/],
  ["תקשורת", /בזק|פרטנר|סלקום|הוט\s*(?:מובייל|טלקום|נט)|HOT|גולן\s*טלקום|אינטרנט|סלולר|טלפוניה|תקשורת|קווי|yes\s/i],
  ["רכב ודלק", /תחנת\s*דלק|סונול|דור\s*אלון|(?:^|\s)פז(?:\s|$)|פז\s*קמעונאות|yellow|דלק\s*(?:חברת|מוטורס|קמעונאות)|אלון\s*רבוע|אוקטן|ליטרים|דלק\s*טן|טן\s*דלק|תדלוק|בנזין|סולר|מוסך|צמיגים|ליסינג|כביש\s*6|טסט\s*לרכב/i],
  ["חניה ותחבורה", /חניה|חנייה|חניון|פנגו|סלופארק|רב[\s-]?קו|רכבת\s*ישראל|מונית|מוניות|טאקסי|טקסי|נסיעה\s*מס|gett|uber|yango|יאנגו|דן\s*בדרום|אגד|מטרופולין|אפיקים|moovit|מוביט/i],
  ["ביטוח", /ביטוח|insurance/i],
  ["שכירות", /שכירות|שכ["״]ד|שכר\s*דירה|\brent\b/i],
  ["תוכנה ומנויים", /מנוי|subscription|google|microsoft|adobe|zoom|apple\.com|תוכנה|software|amazon\s*web|openai|anthropic|wix|canva/i],
  ["ציוד משרדי", /ציוד\s*משרדי|כלי\s*כתיבה|דפוס|הדפסה|נייר|טונר|דיו|office\s*depot|קרביץ/i],
  ["מחשבים ואלקטרוניקה", /מחשב|\bKSP\b|באג\s*מולטי|אלקטרוניקה|computer|laptop|מדפסת/i],
  ["כיבוד ומסעדות", /מסעדה|קפה|ארוחה|כיבוד|פיצה|מאפה|restaurant|cafe|coffee|wolt|תן\s*ביס/i],
  ["סופרמרקט", /שופרסל|רמי\s*לוי|יוחננוף|ויקטורי|אושר\s*עד|מגה\s*בעיר|סופרמרקט|מינימרקט/],
  ["שירותים מקצועיים", /ייעוץ|יעוץ|עו["״]ד|עורך\s*דין|עורכי\s*דין|רואה\s*חשבון|רואי\s*חשבון|הנהלת\s*חשבונות|consult|legal/i],
  ["פרסום ושיווק", /פרסום|שיווק|קמפיין|facebook\s*ads|google\s*ads|meta\s*platforms/i],
  ["אחזקה ותיקונים", /תיקון|תחזוקה|אחזקה|שיפוץ|אינסטלציה|אינסטלטור|חשמלאי|ניקיון|ניקוי|הדברה|שתילי|משתלה|משתלת|פרחים|גינון|איקאה|ikea|(?:^|\s)ace(?:\s|$)|הום\s*סנטר|טמבור/i],
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
  // "כולל מע"מ: 33.70" as a receipt's last line, often misread ("בוללמע''מ")
  [/[כב]ולל\s*מע["״'׳]{0,2}מ\s*:/, 80],
  [/לתשלום|שולם|סכום\s*ששולם|total\s*paid|amount\s*paid/i, 75],
  [new RegExp(`סה${Q}כ|ס[ךד]\\s*הכו?ל|\\btotal\\b`, "i"), 55],
  [/סכום|קניה|\bamount\b|\bsum\b/i, 30],
];
const MONTHS = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];
const MONTHS_EN = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function isoDate(d, m, y) {
  d = +d; m = +m; y = +y;
  if (y < 100) y += 2000;
  // A document is not from the future: a year ahead of this one is a misread digit ("2028" for 2025).
  if (y < 2000 || y > new Date().getFullYear() || m < 1 || m > 12 || d < 1 || d > 31) return "";
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
    .replace(/\d+(?:\.\d+)?\s?%/g, " ")
    // times of day and opening hours ("13:15:31", "07:00-14:00")
    .replace(/(?<![\d.])\d{1,2}:\d{2}(?::\d{2})?(?![\d.])/g, " ")
    // a card's last digits ("Mastercard *5942", "כרטיס 1234") are not money
    .replace(/\*+\s?\d{2,}/g, " ")
    .replace(/(?:mastercard|visa|amex|diners|isracard|ויזה|מאסטרקארד|ישראכרט|אמריקן\s*אקספרס|דיינרס|כרטיס(?:\s*אשראי)?|card)\D{0,8}\d{4}(?!\d)/gi, " ");
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
const GROSS_RE = new RegExp(`סה${Q}כ|סך\\s*הכו?ל|לתשלום|[כב]ולל\\s*מע["״'׳]{0,2}מ\\s*:|\\btotal\\b`, "i");
const isGrossLine = (line) => GROSS_RE.test(line);

// "סה"כ 2 פריטים" counts items, it is not money.
const ITEM_COUNT = /\d+\s*(?:פריטים|פריט|שורות|יחידות|מוצרים|items?)/gi;

function findTotal(lines) {
  let best = null;
  lines = lines.map((l) => l.replace(ITEM_COUNT, " "));
  // On a receipt the total is printed several times (total, paid, the card slip): when the keyword
  // lines give only a tiny number (a misread line), an amount printed three times or more wins.
  const seen = {};
  for (const x of lines.flatMap(amountsIn)) if (x.dec) seen[x.n] = (seen[x.n] || 0) + 1;
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
  const often = Object.entries(seen).sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
  if (often && often[1] >= 3 && (!best || (best.n < 10 && +often[0] > best.n))) return +often[0];
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
  // "קבלה/חשבונית מס" on a till receipt, the second word often misread ("חשב וכ ית-מם")
  [/קבלה\s*[/\\]\s*חשב/, "חשבונית מס קבלה"],
  [new RegExp(`חשבונית\\s*מס\\s*[/\\\\-]?\\s*קבלה|tax\\s*invoice\\s*[/-]?\\s*receipt`, "i"), "חשבונית מס קבלה"],
  [/חשבונית\s*מס|tax\s*invoice/i, "חשבונית מס"],
  [/חשבון\s*עסקה|proforma/i, "חשבון עסקה"],
  [/קבלה|receipt/i, "קבלה"],
  [/חשבונית|invoice/i, "חשבונית"],
];
export const DOC_TYPE_NAMES = ["חשבונית מס קבלה", "חשבונית מס", "קבלה", "חשבון עסקה", "חשבונית זיכוי", "חשבונית", "אחר"];

function findDocNo(text) {
  const res = [
    /(?:חשבונית(?:\s*מס)?(?:\s*[/-]?\s*קבלה)?|קבלה|חשבון\s*עסקה|זיכוי)\s*(?:מס(?:פר|['׳.י])?|#)?\s*:?\s*([A-Z]{0,3}-?\d{3,12})(?![\d./])/, // no /i: lowercase letters before the number are OCR noise
    /מס(?:פר|['׳.])\s*(?:חשבונית|מסמך|קבלה|אסמכתא)\s*:?\s*([A-Z]{0,3}-?\d{3,12})/i,
    /(?:invoice|receipt|document)\s*(?:no\.?|number|#)\s*:?\s*([A-Z]{0,4}-?\d{3,12})/i,
    /אסמכתא\s*:?\s*(\d{3,12})/,
    // "קבלה/חשבונית מס-מספר: 124135"
    /(?:קבלה|חשב)[^\n]{0,25}?מספר\s*:?\s*(\d{3,12})/,
    // OCR often garbles the "מס׳" between the word and the number.
    /(?:חשבונית|קבלה|זיכוי|חשבון\s*עסקה)[^\d\n]{0,12}?(\d{3,12})(?![\d./])/,
  ];
  for (const re of res) { const m = text.match(re); if (m) return m[1]; }
  return "";
}

const NOT_A_NAME = /חשבונית|קבלה|מקור|העתק|נאמן\s*למקור|תאריך|לכבוד|עמוד|דף\s*\d|page|invoice|receipt|copy|original|טלפון|טל['׳.:]|פקס|fax|tel|www\.|@|כתובת|רחוב|רח['׳]|ת\.?ד|מיקוד|לקוח|customer|bill\s*to/i;
const cleanName = (s) => s.replace(ID_RE, "").replace(/(\S)(בע["״']?מ)/, "$1 $2").replace(/[|_*•·]+/g, " ").replace(/\s+/g, " ").replace(/^[\s\-:.,=+~"'״*]+|[\s\-:.,=+~*]+$/g, "").slice(0, 60);

// The customer the document was made out to: for an accountant, her client. The name after "לכבוד"
// comes first; only without one do "שם הלקוח", "Bill to" and the like count.
// A label alone on its line has the name on the next one.
const CUSTOMER_RES = [
  /לכבוד\s*[:\-]?\s*(.*)$/,
  /(?:שם\s*(?:ה)?לקוח|לקוח(?!ות)|שם\s*המזמין|מזמין|bill(?:ed)?\s*to|sold\s*to|customer(?:\s*name)?|client)\s*[:\-]?\s*(.*)$/i,
];
function findCustomer(lines) {
  // What sits beside the name on the same line (a date, "תאריך:", an ID or phone number) is not part of it.
  const pick = (s) => cleanName(s
    .replace(/\s+(?:ת\.?\s?ז|ח\.?\s?פ|ע\.?\s?מ|טל|טלפון|מס['׳]|מספר|תאריך|דוא["״']?ל|e-?mail)[.:'׳\s].*$/i, "")
    .replace(/\s*\d{1,2}[./-]\d{1,2}[./-]\d{2,4}.*$/, "")
    .replace(/\d{5,}.*$/, "")).replace(/^(?:מר|גב['׳.]?|גברת|ה"ה|לכבוד)\s+/, "");
  const isName = (s) => s.replace(/[^\p{L}]/gu, "").length >= 2 && !/^(?:מס|מספר|קוד|ח\.?פ|ת\.?ז|טלפון|כתובת)/.test(s);
  for (const re of CUSTOMER_RES) {
    for (const [i, line] of lines.slice(0, 40).entries()) {
      const m = line.match(re);
      if (!m) continue;
      let name = pick(m[1]);
      if (!isName(name) && lines[i + 1] && !NOT_A_NAME.test(lines[i + 1])) name = pick(lines[i + 1]);
      if (isName(name)) return name;
    }
  }
  return "";
}

// Chains whose name, found anywhere on the page (often only in the logo), is the supplier.
const CHAINS = [
  ["סטימצקי", /סטימצקי|steimatzky/i], ["צומת ספרים", /צומת\s*ספרים/], ["שופרסל", /שופרסל|shufersal/i],
  ["רמי לוי", /רמי\s*לוי/], ["יוחננוף", /יוחננוף/], ["ויקטורי", /ויקטורי/], ["אושר עד", /אושר\s*עד/],
  ["סופר-פארם", /סופר[\s-]*פארם|super-?pharm/i], ["פז", /פז\s*(?:קמעונאות|חברת|נפט)|\byellow\b/i],
  ["סונול", /סונול|sonol/i], ["דור אלון", /דור\s*אלון/], ["איקאה", /איקאה|\bikea\b/i], ["הום סנטר", /הום\s*סנטר/],
  ["בזק", /בזק(?!\s*בינלאומי)/], ["פרטנר", /פרטנר\s*תקשורת/], ["סלקום", /סלקום|cellcom/i],
  ["חברת החשמל", /חברת\s*החשמל|חשמל\s*לישראל/], ["Gett", /\bgett\b/i], ["WeWork", /wework/i],
];
const chainOf = (text) => CHAINS.find(([, re]) => re.test(text));
// A name read from the page that already holds the chain's name stays as it is ("סטימצקי (2005) בע"מ").
function supplierOf(lines, text, hint) {
  const found = findSupplier(lines), chain = chainOf(text) || chainOf(hint);
  return chain && !chain[1].test(found) ? chain[0] : found;
}

const LABEL_TAIL = /\s*(?:שעה|תאריך|קופה|קופאי|מס['׳]?\s*קופה|עמדה)\s*:.*$/;

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
  // Otherwise the first real words at the top of the page, without what is printed beside them on a
  // till receipt ("קיבוץ רעים שעה: 13:15:31", "תאריך: 29/06/25", "קופה: 2").
  for (let line of lines.slice(0, 10)) {
    line = line.replace(LABEL_TAIL, "").trim();
    const letters = line.replace(/[^\p{L}]/gu, "");
    if (letters.length < 3 || NOT_A_NAME.test(line)) continue;
    if (line.replace(/[^\d]/g, "").length > letters.length) continue;
    return cleanName(line);
  }
  return "";
}

// The currency a document is in, when it is not shekels: its sign or name shows up, and no shekel one does
// ("Total $55.00", "סה"כ 20.00 אירו"). "" for shekels or when it cannot tell.
// It counts only beside an amount, and a sign alone ("$", "€") must show up at least twice: a stray sign
// from a misread picture is not dollars. A bare "£" is left out: on Hebrew receipts it is a misread "₪".
const nextTo = (sign) => new RegExp(`(?:${sign})\\s?\\d[\\d,]*(?:\\.\\d{1,2})?|\\d(?:[\\d,]*\\.\\d{1,2}|[\\d,]*)\\s?(?:${sign})`, "gi");
const CURRENCIES = [
  ["USD", nextTo("\\bUSD\\b|דולר"), nextTo("US\\$|\\$")],
  ["EUR", nextTo("\\bEUR\\b|אירו|יורו"), nextTo("€")],
  ["GBP", nextTo("\\bGBP\\b|ליש[\"״']?ט|לירה\\s*שטרלינג"), null],
];
const SHEKEL = /₪|ש["״']ח|\bNIS\b|\bILS\b|שקל/i;
export function findCurrency(text) {
  if (SHEKEL.test(text)) return "";
  const count = (re) => (re ? (text.match(re) || []).length : 0);
  const sure = CURRENCIES.map(([c, name, sign]) => [c, count(name) * 2 + count(sign)])
    .filter(([c, n]) => n >= 2).sort((a, b) => b[1] - a[1])[0];
  return sure ? sure[0] : "";
}

// A receipt for a donation: the word, or the tax-credit section it is given under.
export const isDonation = (text) => /קבלה\s*(?:על|עבור|בגין)?\s*תרומה|תרומה\s*(?:מס['׳]?|מספר|ע["״]ס)|תרומתך|תרומתכם|סעיף\s*46|לעניין\s*סעיף|מוכר\s*לצורכי\s*זיכוי|זיכוי\s*ממס/.test(text);

export function findCategory(text, supplier) {
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

// hint: extra words that only help tell the service type (the logo's, read from the top of the page).
// alt: a second reading of the same picture (see secondReading): every detail comes from the clearer
// reading, and one it lacks from the other.
export function parseText(text, hint = "", alt = "") {
  const a = parseOne(text, hint);
  if (!alt) return a;
  const b = parseOne(alt, hint);
  const [first, second] = clarity(text) >= clarity(alt) ? [a, b] : [b, a];
  const out = { ...first };
  for (const k of Object.keys(out)) if ((out[k] === "" || out[k] == null) && second[k] !== "" && second[k] != null) out[k] = second[k];
  return out;
}

// How readable a reading came out: the words an invoice always has, and real Hebrew words, count; the
// stray marks of a bad reading don't.
function clarity(text) {
  const words = text.split(/\s+/).filter((w) => /^[א-ת"״'׳.]{3,}$/.test(w)).length;
  return hits(text) * 5 + words;
}

function parseOne(text, hint = "") {
  text = text.replace(/[‎‏‪-‮⁦-⁩]/g, ""); // invisible direction marks from OCR
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const total = findTotal(lines);
  const vat = findVat(lines, total);
  const supplier = supplierOf(lines, text, hint);
  let docType = "";
  for (const [re, name] of DOC_TYPES) if (re.test(text)) { docType = name; break; }
  return {
    date: findDate(lines),
    amount: total,
    vat,
    supplier,
    customer: findCustomer(lines),
    // "51-374232-0": a company number written with dashes, even when its label was misread.
    supplierId: text.match(ID_RE)?.[1] || text.match(/(?<![\d-])(5\d)-(\d{6})-(\d)(?![\d-])/)?.slice(1).join("") || "",
    docType,
    docNo: findDocNo(text),
    category: isDonation(text) ? "תרומות" : findCategory(text, supplier) || findCategory(hint, supplier),
    details: findDetails(lines),
    currency: findCurrency(text),
    donation: isDonation(text),
  };
}

// Form 106: the year, the employer, the pay and the income tax deducted, by the form's codes (158/172 and 042)
// or their names. Whatever is not found stays empty, to fill in by hand.
export function parse106(text) {
  const lines = String(text || "").split("\n");
  const CODE = /(?<!\d)(?:158|172|042)(?!\d)/g;
  const numbers = (l) => [...l.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{3,7}(?:\.\d+)?/g)]
    .filter((m) => m[0].includes(",") || !/^(?:158|172|042|106|20\d\d)$/.test(m[0]))
    .map((m) => ({ at: m.index, n: parseFloat(m[0].replace(/,/g, "")) })).filter((x) => x.n > 0);
  // A code's number, by the side the numbers stand on in that line: after each code when any number follows
  // the last code, before each code otherwise (one line may hold several of the form's fields).
  const byCode = (l, wanted) => {
    const codes = [...l.matchAll(CODE)], nums = numbers(l), last = codes[codes.length - 1];
    const after = nums.some((x) => x.at > last.index);
    for (const c of codes.filter((m) => wanted.includes(m[0]))) {
      const found = after ? nums.find((x) => x.at > c.index) : nums.filter((x) => x.at < c.index).pop();
      if (found) return found.n;
    }
    return null;
  };
  const money = (wanted, name) => {
    for (const l of lines) {
      if (![...l.matchAll(CODE)].some((m) => wanted.includes(m[0]))) continue;
      const n = byCode(l, wanted);
      if (n != null) return n;
    }
    // by the field's name, the number nearest it
    for (const l of lines) {
      const m = l.match(name);
      if (!m) continue;
      const near = numbers(l).sort((a, b) => Math.abs(a.at - m.index) - Math.abs(b.at - m.index))[0];
      if (near) return near.n;
    }
    return null;
  };
  const all = lines.join(" ");
  const year = (all.match(/(?:לשנת|שנת\s*(?:ה)?מס)\D{0,10}(20\d\d)/) || all.match(/\b(20\d\d)\b/))?.[1] || "";
  const employer = (lines.map((l) => l.match(/שם\s*(?:ה)?מעסיק[:\s]+([^\d:(]{2,40})/)?.[1]).find(Boolean) || "").trim();
  return {
    year, employer,
    gross: money(["158", "172"], /סה["״]?כ\s*תשלומים|משכורת/),
    tax: money(["042"], /מס\s*הכנסה/),
  };
}
