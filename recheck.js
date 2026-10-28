// What a document's file path tells, and filling in from it what the document's own reading missed.
// People keep receipts in folders by kind ("הוצאות/2025/רכב/דלק/22.4.pdf") and often name a file by its
// date or month: the folders give the service type and the account, the name the date.
// Used when a document is taken in and when documents already in the system are checked again.

import { suggestAccount, categoryOfAccount } from "./accounts.js?v=5";
import { findCategory } from "./extract.js?v=10";

const MONTHS = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];
const iso = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

// "הוצאות/קבלות על הוצאות 2025/רכב/דלק/22.4.pdf" -> { folders: "הוצאות קבלות על הוצאות 2025 רכב דלק", name: "22.4", year: 2025 }
export function pathParts(fileName) {
  const path = String(fileName || "").split(" › ")[0].replace(/\\/g, "/");
  const parts = path.split("/");
  const name = parts.pop().replace(/\.[^.]+$/, "");
  const folders = parts.join(" ");
  const year = +((folders.match(/(?:^|\D)(20\d{2})(?!\d)/) || [])[1] || 0);
  return { folders, name, year };
}

// The date a file's name gives, if any: "22.4" or "22.4.25" (the year from the folders when missing),
// "2025-10-31" (as phones name pictures), or a month, "נובמבר 25", taken as its last day — the way
// monthly bills are dated in the books.
export function dateFromName(fileName) {
  const { name, year } = pathParts(fileName);
  const now = new Date();
  const ok = (y, m, d) => y >= 2000 && m >= 1 && m <= 12 && d >= 1 && d <= lastDay(y, m) && iso(y, m, d) <= now.toISOString().slice(0, 10);
  let m = name.match(/(20\d{2})-(\d{1,2})-(\d{1,2})/);
  if (m && ok(+m[1], +m[2], +m[3])) return iso(+m[1], +m[2], +m[3]);
  m = name.match(/(?:^|[^\d.])(\d{1,2})\.(\d{1,2})(?:\.(\d{2}|\d{4}))?(?![\d.])/);
  if (m) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : year;
    if (y && ok(y, +m[2], +m[1])) return iso(y, +m[2], +m[1]);
  }
  const month = MONTHS.findIndex((mo) => name.includes(mo));
  if (month >= 0) {
    const ym = name.slice(name.indexOf(MONTHS[month])).match(/(\d{4}|\d{2})(?!\d)/);
    const y = ym ? (ym[1].length === 2 ? 2000 + +ym[1] : +ym[1]) : year;
    if (y && ok(y, month + 1, lastDay(y, month + 1))) return iso(y, month + 1, lastDay(y, month + 1));
  }
  return "";
}

// Fills in, from the file's path and the document's text, what is still missing: the date, the service
// type, and the journal account (unless someone chose that by hand). Returns the fields it changed.
export function fillFromPath(rec, text = "") {
  const { folders, name } = pathParts(rec.fileName);
  const where = `${folders} ${name}`;
  const changed = {};
  // A year that cannot be right is a misread digit ("08/02/75" for 08/02/25): one in the future, or
  // more than a year from the year the folders name, takes the folders' year; with no year there to
  // go by, the date is cleared and the document waits for review.
  const { year } = pathParts(rec.fileName);
  const y = +(rec.date || "").slice(0, 4);
  if (y && (y > new Date().getFullYear() || (year && Math.abs(y - year) > 1))) {
    const fixed = year ? `${year}${rec.date.slice(4)}` : "";
    changed.date = fixed && fixed <= new Date().toISOString().slice(0, 10) ? fixed : "";
    rec.date = changed.date;
  }
  if (!rec.date) {
    const d = dateFromName(rec.fileName);
    if (d) changed.date = d;
  }
  if (rec.accountBy !== "hand") {
    const account = suggestAccount({ ...rec, ...changed }, text, where);
    if (account !== rec.account) changed.account = account;
    if (rec.accountBy !== "auto") changed.accountBy = "auto";
  }
  if (!rec.category) {
    const account = changed.account || rec.account;
    const category = findCategory(where, rec.supplier || "") || (account && account !== "630000" ? categoryOfAccount(account) : "");
    if (category) changed.category = category;
  }
  Object.assign(rec, changed);
  return changed;
}
