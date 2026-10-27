import { firebaseConfig, OWNER_EMAILS } from "./firebase-config.js";
import { readFile, parseText, CATEGORY_NAMES, DOC_TYPE_NAMES, READABLE, MIME } from "./extract.js?v=7";

const $ = (id) => document.getElementById(id);
const fmt = (n) => (n < 0 ? "-" : "") + "₪" + Math.abs(n || 0).toLocaleString("he-IL", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const showDate = (iso) => (iso ? iso.split("-").reverse().join(".") : "");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const round2 = (n) => Math.round(n * 100) / 100;
const net = (r) => round2((r.amount || 0) - (r.vat || 0));

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3500);
}

// ---------- storage: Firestore when configured, this browser otherwise ----------
// A record holds the details only; its picture sits apart in previews/{id} and is read when opened.

const CLOUD = !!firebaseConfig.apiKey;
let store;

if (CLOUD) {
  const V = "https://www.gstatic.com/firebasejs/10.12.2/";
  const { initializeApp } = await import(V + "firebase-app.js");
  const fa = await import(V + "firebase-auth.js");
  const fs = await import(V + "firebase-firestore.js");
  const app = initializeApp(firebaseConfig);
  const auth = fa.getAuth(app);
  const db = fs.getFirestore(app);
  const col = fs.collection(db, "docs");
  store = {
    auth, fa,
    watch: (cb, onErr) => fs.onSnapshot(col, (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))), onErr),
    async add(rec, preview) {
      const ref = await fs.addDoc(col, { ...rec, createdAt: fs.serverTimestamp(), createdBy: auth.currentUser.email });
      if (preview) await fs.setDoc(fs.doc(db, "previews", ref.id), { dataUrl: preview });
      return ref.id;
    },
    update: (id, rec) => fs.setDoc(fs.doc(db, "docs", id), { ...rec, updatedAt: fs.serverTimestamp(), updatedBy: auth.currentUser.email }, { merge: true }),
    async remove(id) {
      await fs.deleteDoc(fs.doc(db, "previews", id));
      await fs.deleteDoc(fs.doc(db, "docs", id));
    },
    async preview(id) { return (await fs.getDoc(fs.doc(db, "previews", id))).data()?.dataUrl || ""; },
    async allowed(email) {
      if (OWNER_EMAILS.includes(email)) return true;
      try { return (await fs.getDoc(fs.doc(db, "access", email.toLowerCase()))).exists(); } catch { return false; }
    },
    watchClients: (cb, onErr) => fs.onSnapshot(fs.collection(db, "clients"), (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))), onErr),
    addClient: (name) => fs.addDoc(fs.collection(db, "clients"), { name, createdAt: fs.serverTimestamp(), createdBy: auth.currentUser.email }),
    watchAccess: (cb) => fs.onSnapshot(fs.collection(db, "access"), (snap) => cb(snap.docs.map((d) => d.id))),
    addAccess: (email) => fs.setDoc(fs.doc(db, "access", email), { addedAt: fs.serverTimestamp(), addedBy: auth.currentUser.email }),
    removeAccess: (email) => fs.deleteDoc(fs.doc(db, "access", email)),
  };
} else {
  const KEY = "fairy-docs", PKEY = "fairy-preview-", CKEY = "fairy-clients";
  const listeners = new Set(), clientListeners = new Set();
  const readJson = (k) => { try { return JSON.parse(localStorage.getItem(k)) || []; } catch { return []; } };
  const write = (all) => { localStorage.setItem(KEY, JSON.stringify(all)); listeners.forEach((cb) => cb(readJson(KEY))); };
  store = {
    watch(cb) { listeners.add(cb); cb(readJson(KEY)); return () => listeners.delete(cb); },
    async add(rec, preview) {
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      write([...readJson(KEY), { ...rec, id, createdAt: new Date().toISOString() }]);
      try { if (preview) localStorage.setItem(PKEY + id, preview); } catch { /* the browser's space is small; keep the details anyway */ }
      return id;
    },
    async update(id, rec) { write(readJson(KEY).map((r) => (r.id === id ? { ...r, ...rec } : r))); },
    async remove(id) { localStorage.removeItem(PKEY + id); write(readJson(KEY).filter((r) => r.id !== id)); },
    async preview(id) { return localStorage.getItem(PKEY + id) || ""; },
    watchClients(cb) { const f = () => cb(readJson(CKEY)); clientListeners.add(f); f(); return () => clientListeners.delete(f); },
    async addClient(name) {
      localStorage.setItem(CKEY, JSON.stringify([...readJson(CKEY), { id: Date.now().toString(36), name }]));
      clientListeners.forEach((f) => f());
    },
  };
}

// ---------- sign-in ----------

let user = null, records = [], clients = [], unsub = null, unsubClients = null;
// The client being worked on; ALL shows everyone's documents together.
const ALL = "*";
let client = null;
const inScope = (r) => client === ALL || r.client === client;

function showLogin(err = "") {
  if (unsub) { unsub(); unsub = null; }
  if (unsubClients) { unsubClients(); unsubClients = null; }
  $("loginErr").textContent = err;
  $("appView").hidden = $("clientView").hidden = true;
  $("loginView").hidden = false;
}

function enterApp() {
  $("loginView").hidden = true;
  $("userEmail").textContent = $("cvEmail").textContent = user?.email || "";
  $("modeNote").hidden = CLOUD;
  $("logoutBtn").hidden = !CLOUD;
  $("shareBtn").hidden = !(CLOUD && OWNER_EMAILS.includes(user.email));
  const denied = (err) => showLogin(err.code === "permission-denied"
    ? `לחשבון ${user.email} אין הרשאה. בקשו מהבעלים לשתף אתכם.`
    : "שגיאה בטעינת הנתונים: " + err.message);
  unsub = store.watch((all) => { records = all; renderAll(); }, denied);
  unsubClients = store.watchClients((all) => { clients = all; renderAll(); }, denied);
  showClients();
}

const AUTH_ERRORS = {
  "auth/popup-closed-by-user": "חלון הכניסה נסגר לפני שהכניסה הסתיימה. נסו שוב.",
  "auth/network-request-failed": "אין חיבור לאינטרנט. בדקו את החיבור ונסו שוב.",
  "auth/unauthorized-domain": "האתר לא מורשה לכניסה עם Google. צריך להוסיף אותו ב-Firebase.",
  "auth/invalid-credential": "המייל או הסיסמה לא נכונים.",
  "auth/wrong-password": "המייל או הסיסמה לא נכונים.",
  "auth/user-not-found": "אין משתמש עם המייל הזה.",
  "auth/too-many-requests": "יותר מדי ניסיונות. נסו שוב בעוד כמה דקות.",
};
const authError = (e) => AUTH_ERRORS[e.code] || `הכניסה נכשלה (${e.code || e.message}).`;

if (CLOUD) {
  const { auth, fa } = store;
  $("googleBtn").onclick = async () => {
    $("loginErr").textContent = "";
    try { await fa.signInWithPopup(auth, new fa.GoogleAuthProvider()); }
    catch (e) {
      if (e.code === "auth/popup-blocked") return fa.signInWithRedirect(auth, new fa.GoogleAuthProvider());
      $("loginErr").textContent = authError(e);
    }
  };
  $("pwForm").onsubmit = async (ev) => {
    ev.preventDefault();
    $("loginErr").textContent = "";
    try { await fa.signInWithEmailAndPassword(auth, $("pwEmail").value.trim(), $("pwPass").value); $("pwPass").value = ""; }
    catch (e) { $("loginErr").textContent = authError(e); }
  };
  $("pwReset").onclick = async () => {
    const email = $("pwEmail").value.trim();
    if (!email) { $("loginErr").textContent = "כתבו את המייל ואז לחצו שוב על \"שכחתי סיסמה\"."; return; }
    try { await fa.sendPasswordResetEmail(auth, email); toast("נשלח מייל לאיפוס הסיסמה"); }
    catch (e) { $("loginErr").textContent = authError(e); }
  };
  $("logoutBtn").onclick = () => fa.signOut(auth);
  fa.getRedirectResult(auth).catch((e) => { $("loginErr").textContent = authError(e); });
  fa.onAuthStateChanged(auth, async (u) => {
    user = u;
    if (!u) return showLogin();
    if (!(await store.allowed(u.email))) {
      await fa.signOut(auth);
      return showLogin(`החשבון ${u.email} לא מורשה. בקשו מהבעלים להוסיף אותו בשיתוף.`);
    }
    enterApp();
  });
} else {
  setTimeout(enterApp); // after the rest of this module has set up
}

// ---------- clients ----------
// After signing in a dropdown of the clients (with how many documents each has and how many wait
// for review); the same dropdown sits in the side menu to switch at any time.

const clientNames = () => [...new Set([...clients.map((c) => c.name), ...records.map((r) => r.client)].filter(Boolean))]
  .sort((a, b) => a.localeCompare(b, "he"));
const lastClient = () => { try { return localStorage.getItem("fairy-last-client") || ""; } catch { return ""; } };
const needsReview = (r) => r.status === "review" || r.status === "failed" || dupOf.has(r.id);

function clientOptions(selected) {
  const label = (name) => {
    const mine = name === ALL ? records : records.filter((r) => r.client === name);
    const review = mine.filter(needsReview).length;
    return `${mine.length} מסמכים${review ? `, ${review} לבדיקה` : ""}`;
  };
  const opt = (value, text) => `<option value="${esc(value)}"${value === selected ? " selected" : ""}>${esc(text)}</option>`;
  const unassigned = records.filter((r) => !r.client).length;
  return opt(ALL, `📚 כל הלקוחות (${label(ALL)})`)
    + clientNames().map((n) => opt(n, `${n} (${label(n)})`)).join("")
    + (unassigned ? opt("", `❓ לא שויכו ללקוח (${unassigned})`) : "");
}

function showClients() {
  $("appView").hidden = true;
  $("clientView").hidden = false;
  renderClientPickers();
  $("clientSelect").focus();
}

function renderClientPickers() {
  const pick = $("clientView").hidden ? client : (client ?? (lastClient() || ALL));
  $("clientSelect").innerHTML = clientOptions(pick);
  if (client !== null) $("navClient").innerHTML = clientOptions(client);
  // Upload with "all clients": each document goes to the client named on it, or to one picked here.
  $("uploadClient").innerHTML = '<option value="">🔎 לפי שם הלקוח שבמסמך</option>'
    + clientNames().map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
}

$("clientForm").onsubmit = (e) => { e.preventDefault(); chooseClient($("clientSelect").value); };
$("navClient").onchange = () => chooseClient($("navClient").value);

async function addClient(name) {
  name = name.trim().replace(/\s+/g, " ");
  if (!name) return false;
  if (!clientNames().includes(name)) {
    try { await store.addClient(name); }
    catch (err) { toast("ההוספה נכשלה: " + err.message); return false; }
  }
  return name;
}
$("newClientForm").onsubmit = async (e) => {
  e.preventDefault();
  const name = await addClient($("newClientName").value);
  if (!name) return;
  $("newClientName").value = "";
  chooseClient(name);
};
$("addClientBtn").onclick = async () => {
  const name = await addClient(prompt("שם הלקוח החדש:") || "");
  if (name) chooseClient(name);
};

function chooseClient(name) {
  client = name;
  try { localStorage.setItem("fairy-last-client", name); } catch {}
  const all = name === ALL;
  const title = all ? "" : `· ${name || "לא שויכו ללקוח"}`;
  $("pageClient").textContent = $("pageClient2").textContent = $("pageClient3").textContent = title;
  $("clientPick").hidden = !all;
  $("clientFixed").hidden = all;
  $("clientFixed").innerHTML = all ? "" : `המסמכים יישמרו ללקוח: <b>${esc(name || "ללא שיוך")}</b>`;
  $("clientFilter").hidden = $("sumClient").hidden = !all;
  $("clientFilter").value = $("sumClient").value = "";
  $("clientView").hidden = true;
  $("appView").hidden = false;
  renderAll();
}

// ---------- menu ----------

function showView(name) {
  document.querySelectorAll("#sideNav > button[data-view]").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  document.querySelectorAll(".view-panel").forEach((p) => p.classList.toggle("view-active", p.dataset.view === name));
}
document.querySelectorAll("#sideNav > button[data-view]").forEach((b) => (b.onclick = () => showView(b.dataset.view)));

// ---------- the form fields of a document ----------

const FIELDS = [
  { k: "client", label: "לקוח", options: () => clientNames() },
  { k: "customer", label: "שם הלקוח כפי שמופיע במסמך" },
  { k: "date", label: "תאריך", type: "date", need: true },
  { k: "supplier", label: "ספק", need: true },
  { k: "supplierId", label: "ח.פ / ע.מ" },
  { k: "category", label: "סוג שירות", list: "catList", need: true },
  { k: "docType", label: "סוג מסמך", options: () => DOC_TYPE_NAMES },
  { k: "docNo", label: "מספר מסמך" },
  { k: "amount", label: "סכום כולל מע״מ (₪)", type: "number", need: true },
  { k: "vat", label: "מע״מ (₪)", type: "number" },
  { k: "details", label: "פירוט", wide: true },
];

function fieldsHtml(v) {
  return FIELDS.map((f) => {
    const val = v[f.k] ?? "";
    let input;
    if (f.options) {
      const list = f.options();
      const all = val && !list.includes(val) ? [val, ...list] : list;
      input = `<select name="${f.k}"><option value=""></option>${all.map((o) => `<option${o === val ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
    } else {
      input = `<input name="${f.k}" type="${f.type || "text"}" value="${esc(val)}"${f.list ? ` list="${f.list}" autocomplete="off"` : ""}${f.type === "number" ? ' step="0.01" inputmode="decimal" dir="ltr"' : ""}>`;
    }
    return `<label class="${f.wide ? "wide " : ""}${f.need && (val === "" || val == null) ? "miss" : ""}" data-need="${f.need ? 1 : ""}">${f.label}${input}</label>`;
  }).join("") + '<span class="calc"></span>';
}

function bindFields(box) {
  const update = () => {
    box.querySelectorAll("label[data-need='1']").forEach((l) => l.classList.toggle("miss", !l.querySelector("input,select").value));
    const r = readFields(box);
    box.querySelector(".calc").textContent = r.amount ? `לפני מע״מ: ${fmt(net(r))}` : "";
  };
  box.addEventListener("input", update);
  update();
}

function readFields(box) {
  const out = {};
  for (const f of FIELDS) {
    const v = box.querySelector(`[name=${f.k}]`).value.trim();
    out[f.k] = f.type === "number" ? (v === "" ? null : round2(parseFloat(v))) : v;
  }
  return out;
}

// ---------- duplicates ----------
// The same file (byte for byte, by its SHA-256 fingerprint), or the same document scanned again:
// same supplier with the same document number, or the same supplier, date and amount.

const normName = (s) => String(s || "").replace(/[^\p{L}\d]/gu, "").replace(/בעמ$|ltd$/i, "");
const sameName = (a, b) => {
  const x = normName(a), y = normName(b);
  return x.length >= 2 && y.length >= 2 && (x.includes(y) || y.includes(x));
};
const sameSupplier = (a, b) => (a.supplierId && a.supplierId === b.supplierId) || sameName(a.supplier, b.supplier);
// Why two records look like the same document ("" when they don't).
function dupReason(a, b) {
  if (a.fileHash && a.fileHash === b.fileHash) return "אותו קובץ בדיוק";
  if (a.docNo && a.docNo === b.docNo && sameSupplier(a, b)) return "אותו ספק ואותו מספר מסמך";
  if (a.amount && a.amount === b.amount && a.date && a.date === b.date && sameSupplier(a, b)) return "אותו ספק, תאריך וסכום";
  return "";
}
const describe = (x) => [x.client, x.supplier, showDate(x.date), x.amount ? fmt(x.amount) : "", x.fileName].filter(Boolean).join(" · ");

// Saved this session but maybe not yet back from the database, so a copy right behind it is still caught.
const savedNow = [];
function findDuplicate(r, exceptId) {
  const seen = new Set();
  for (const x of [...records, ...savedNow]) {
    if (x.id === exceptId || seen.has(x.id)) continue;
    seen.add(x.id);
    const why = dupReason(r, x);
    if (why) return { why, what: describe(x), id: x.id };
  }
  return null;
}

async function fingerprint(file) {
  const hash = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- what needs a person to look at it ----------

// The reasons a record should be checked by hand ([] when it is fine).
function reviewReasons(r, { exceptId, noText = false, failed = "" } = {}) {
  const why = [];
  if (failed) why.push(`הקובץ לא נקרא (${failed})`);
  else if (noText) why.push("לא נמצא טקסט במסמך");
  const missing = FIELDS.filter((f) => f.need && !r[f.k]).map((f) => f.label.replace(/ \(.*\)/, ""));
  if (missing.length && !failed) why.push(`חסר: ${missing.join(", ")}`);
  // A document uploaded under a client is theirs even when made out to someone else (a spouse, say).
  if (!r.client) why.push(r.customer ? `הלקוח "${r.customer}" שבמסמך לא נמצא ברשימת הלקוחות` : "לא שויך ללקוח");
  const dup = findDuplicate(r, exceptId);
  if (dup) why.push(`ייתכן כפילות (${dup.why}) של: ${dup.what}`);
  return why;
}

// ---------- intake ----------

// Files, whole folders (picked or dragged) and ZIP files; a ZIP may hold folders and other ZIPs.
const drop = $("drop");
for (const id of ["fileInput", "folderInput"]) $(id).onchange = (e) => { addFiles([...e.target.files]); e.target.value = ""; };
$("pickFiles").onclick = () => $("fileInput").click();
$("pickFolder").onclick = () => $("folderInput").click();
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  // The entries must be taken now, while the drop event lasts; reading them can wait.
  const entries = [...e.dataTransfer.items].map((it) => it.webkitGetAsEntry?.()).filter(Boolean);
  if (entries.length) Promise.all(entries.map(readEntry)).then((lists) => addFiles(lists.flat()));
  else addFiles([...e.dataTransfer.files]);
});
// Pasting a screenshot (Ctrl+V) works too.
document.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length && !$("appView").hidden) addFiles(files);
});
// Closing the page while files are still being read loses the ones not read yet: ask first.
addEventListener("beforeunload", (e) => { if (prog.done < prog.total) { e.preventDefault(); e.returnValue = ""; } });

// A dragged file or folder -> [{ file, path }].
async function readEntry(entry) {
  if (entry.isFile) {
    const file = await new Promise((ok, bad) => entry.file(ok, bad));
    return [{ file, path: entry.fullPath.replace(/^\//, "") }];
  }
  const reader = entry.createReader(), children = [];
  // readEntries hands out the folder in chunks (about 100 at a time) until it returns none.
  for (let chunk; (chunk = await new Promise((ok, bad) => reader.readEntries(ok, bad))).length;) children.push(...chunk);
  return (await Promise.all(children.map(readEntry))).flat();
}

const MAX_FILES = 300, MAX_SIZE = 30 * 1024 * 1024;
const isZip = (f) => /\.zip$/i.test(f.name) || /zip/.test(f.type);
const extOf = (name) => (name.match(/\.([^./]+)$/)?.[1] || "").toLowerCase();

// Why a file can't be taken in, in words the person can act on.
const NOT_READABLE = {
  doc: "קובץ Word ישן (.doc). שמרו אותו כ-docx או PDF",
  xls: "גיליון אקסל. ייצאו את המסמך ל-PDF", xlsx: "גיליון אקסל. ייצאו את המסמך ל-PDF", csv: "קובץ נתונים (CSV), לא מסמך",
  msg: "הודעת מייל. שמרו את הקבצים המצורפים", eml: "הודעת מייל. שמרו את הקבצים המצורפים",
  rar: "קובץ דחוס שאינו ZIP. פרסו אותו או דחסו מחדש כ-ZIP", "7z": "קובץ דחוס שאינו ZIP. פרסו אותו או דחסו מחדש כ-ZIP",
  txt: "קובץ טקסט, לא מסמך", lnk: "קיצור דרך, לא הקובץ עצמו", ini: "קובץ מערכת",
};
const whyNot = (name) => NOT_READABLE[extOf(name)] || (extOf(name) ? `סוג קובץ שלא נתמך (.${extOf(name)})` : "קובץ בלי סיומת");

let jszipReady;
function jszip() {
  jszipReady ||= new Promise((ok, bad) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
    s.onload = () => ok(window.JSZip);
    s.onerror = () => bad(new Error("לא הצלחתי לטעון את רכיב פריסת ה-ZIP"));
    document.head.appendChild(s);
  });
  return jszipReady;
}
// ZIPs made by Windows without the UTF-8 flag keep Hebrew names in the old Hebrew code page.
function zipName(bytes) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return new TextDecoder("windows-1255").decode(bytes); }
}

async function unzip(file, path, out, missed) {
  const JSZip = await jszip();
  const zip = await JSZip.loadAsync(file, { decodeFileName: zipName });
  for (const entry of Object.values(zip.files)) {
    const name = entry.name.split("/").pop();
    if (entry.dir || !name || name.startsWith(".") || entry.name.startsWith("__MACOSX/")) continue;
    const inner = `${path}/${entry.name}`;
    if (!READABLE.test(name) && !/\.zip$/i.test(name)) { missed.push({ path: inner, why: whyNot(name) }); continue; }
    const blob = await entry.async("blob");
    await collect({ file: new File([blob], name, { type: MIME[extOf(name)] || (extOf(name) === "zip" ? "application/zip" : "") }), path: inner }, out, missed);
  }
}

// Sorts what was dropped or picked into documents to read and files left out (with the reason).
async function collect({ file, path }, out, missed) {
  path ||= file.webkitRelativePath || file.name;
  if (file.name.startsWith(".") || /^(desktop\.ini|thumbs\.db)$/i.test(file.name)) return;
  if (file.size > MAX_SIZE) missed.push({ path, why: "גדול מ-30MB" });
  else if (isZip(file)) {
    try { await unzip(file, path.replace(/\.zip$/i, ""), out, missed); }
    catch { missed.push({ path, why: "קובץ ה-ZIP פגום או מוגן בסיסמה" }); }
  } else if (!(READABLE.test(file.name) || /pdf|image/.test(file.type))) missed.push({ path, why: whyNot(file.name) });
  else if (out.length >= MAX_FILES) missed.push({ path, why: `מעל ${MAX_FILES} מסמכים בהעלאה אחת. העלו אותו בפעם הבאה` });
  else out.push({ file, path });
}

async function addFiles(list) {
  if (!list.length) return;
  showView("upload");
  if (prog.done >= prog.total) progReset();
  progNote(`⏳ מכין ${list.length > 1 ? `${list.length} קבצים` : "את הקובץ"} לקריאה…`);
  const out = [], missed = [];
  try {
    for (const x of list) await collect(x instanceof File ? { file: x } : x, out, missed);
  } catch (e) {
    progNote(`❌ לא הצלחתי לפתוח את הקבצים: ${esc(e.message)}`, true);
    return;
  }
  prog.missed.push(...missed);
  renderMissed();
  if (!out.length) { progNote("⚠️ לא נמצאו מסמכים שאפשר לקרוא.", true); return; }
  progStart(out.length);
  // One block per upload, newest on top, its files in their own order.
  const batch = document.createElement("div");
  $("queue").prepend(batch);
  for (const { file, path } of out) processFile(file, path, batch);
}

// ---------- progress of the whole upload ----------
// One panel for everything being read: how many are done, roughly how long is left, how the
// finished ones came out, and a list of every file that was not taken in and why.

const TITLE = document.title;
const prog = { total: 0, done: 0, missed: [] };
function progReset() {
  Object.assign(prog, { total: 0, done: 0, ok: 0, review: 0, skipped: 0, failed: 0, started: Date.now(), ended: 0, share: new Map(), missed: [] });
  renderMissed();
}
function progStart(n) {
  prog.total += n;
  renderProgress();
}
function progStep(item, p) { prog.share.set(item, p); renderProgress(); }
function progDone(item, kind) {
  if (item.counted) return;
  item.counted = true;
  prog.share.delete(item);
  prog.done++;
  prog[kind]++;
  if (prog.done >= prog.total) prog.ended = Date.now();
  renderProgress();
}

// A line in the panel that stays until there is progress to show.
function progNote(text, warn = false) {
  $("progress").hidden = false;
  $("progress").className = "progress" + (warn ? " warn" : "");
  $("progMain").innerHTML = `<div class="prog-head"><b>${text}</b></div>`;
}

const minutes = (ms) => { const m = Math.round(ms / 60000); return m < 1 ? "פחות מדקה" : m === 1 ? "דקה" : `${m} דקות`; };
const chip = (icon, n, label) => (n ? `<span class="chip">${icon} ${n} ${label}</span>` : "");
function renderProgress() {
  if (renderProgress.raf) return;
  renderProgress.raf = requestAnimationFrame(() => {
    renderProgress.raf = 0;
    const box = $("progress");
    if (prog.total < 2) {
      if (!prog.missed.length) box.hidden = true;
      document.title = TITLE;
      return;
    }
    const part = [...prog.share.values()].reduce((s, p) => s + p, 0);
    const frac = Math.min(1, (prog.done + part) / prog.total), pct = Math.floor(frac * 100);
    const finished = prog.done >= prog.total;
    const elapsed = (finished ? prog.ended : Date.now()) - prog.started;
    const rest = (elapsed / frac) * (1 - frac);
    const left = finished ? "" : frac < 0.03 ? "מחשב כמה זמן זה ייקח…" : rest < 60000 ? "נשארה פחות מדקה" : `נשארו עוד כ-${minutes(rest)}`;
    box.hidden = false;
    box.className = "progress" + (finished ? " finished" : "");
    $("progMain").innerHTML = `<div class="prog-head">
        <b>${finished ? `✨ הקליטה הסתיימה: ${prog.total} מסמכים תוך ${minutes(elapsed)}` : `קולט מסמכים: ${prog.done} מתוך ${prog.total}`}</b>
        <span class="grow">${left}</span><b class="pct">${pct}%</b></div>
      <div class="bar"><i style="width:${frac * 100}%"></i></div>
      <div class="prog-chips">${chip("✅", prog.ok, "נשמרו")}${chip("⚠️", prog.review, "נשמרו לבדיקה")}${chip("⏭️", prog.skipped, "דולגו (כבר קיימים)")}${chip("❌", prog.failed, "לא נשמרו")}</div>
      ${finished && prog.review ? '<button type="button" class="primary to-review">⚠️ למסמכים שמחכים לבדיקה</button>' : ""}`;
    document.title = finished ? TITLE : `(${pct}%) ${TITLE}`;
  });
}
// While files are being read the time left keeps counting down even between steps.
setInterval(() => { if (prog.done < prog.total) renderProgress(); }, 5000);
$("progMain").addEventListener("click", (e) => { if (e.target.closest(".to-review")) showReview(); });

function showReview() {
  $("reviewOnly").checked = true;
  renderTable();
  showView("docs");
}

// The files that were not taken in, each with its reason; kept apart from the progress
// so the list stays open while the progress above it updates.
function renderMissed() {
  const list = prog.missed, el = $("progMissed");
  if (!list.length) { el.innerHTML = ""; return; }
  $("progress").hidden = false;
  const wasOpen = el.querySelector("details")?.open ?? list.length <= 10;
  el.innerHTML = `<details class="missed"${wasOpen ? " open" : ""}>
      <summary>⚠️ <b>${list.length} קבצים לא נקלטו</b> (לחצו לרשימה)</summary>
      <ul>${list.map((m) => `<li><span class="ltr-path">${esc(m.path)}</span> <small>${esc(m.why)}</small></li>`).join("")}</ul>
      <button type="button" class="ghost" id="copyMissed">📋 העתקת הרשימה</button>
    </details>`;
  $("copyMissed").onclick = async () => {
    const txt = list.map((m) => `${m.path}\t${m.why}`).join("\n");
    try { await navigator.clipboard.writeText(txt); toast("הרשימה הועתקה"); } catch { prompt("העתיקו את הרשימה:", txt); }
  };
}

// At most two files are read at a time, so a big folder doesn't choke the browser.
let reading = 0;
const waitingToRead = [];
async function oneAtATime(fn) {
  if (reading >= 2) await new Promise((ok) => waitingToRead.push(ok));
  reading++;
  try { return await fn(); }
  finally { reading--; waitingToRead.shift()?.(); }
}

// The client a new document belongs to: the one being worked on, the one picked for this upload,
// or (with "all clients") the known client whose name appears on the document.
function clientFor(customer) {
  if (client && client !== ALL) return client;
  if ($("uploadClient").value) return $("uploadClient").value;
  return (customer && clientNames().find((n) => sameName(n, customer))) || "";
}

// Hashes being read right now, so a second copy in the same upload is caught before it is saved.
const inFlight = new Map();

// Each file: read it, find the details, and save it straight away, marked for review when
// anything is missing or doubtful. Only an exact copy of a file already in the system is skipped.
async function processFile(file, path, batch) {
  const el = document.createElement("div");
  el.className = "item";
  el.innerHTML = `<div class="thumb"><span class="soon">⏳</span></div>
    <div class="body"><span class="fname">${esc(path)}</span><div class="status"><span class="label">ממתין…</span><div class="bar"><i></i></div></div></div>`;
  batch.append(el);
  const body = el.querySelector(".body");
  const status = (p, label) => {
    el.querySelector(".bar i").style.width = Math.round(p * 100) + "%";
    if (label) el.querySelector(".label").textContent = label;
    progStep(item, p);
  };
  const item = {};
  progStep(item, 0);
  const show = (cls, html, actions = "") => {
    el.className = `item ${cls}`;
    body.innerHTML = `<span class="fname">${esc(path)}</span><div class="result">${html}</div>${actions ? `<div class="item-actions">${actions}</div>` : ""}`;
  };

  let hash;
  try { hash = await fingerprint(file); } catch { hash = ""; }
  const sameFile = hash && (inFlight.get(hash) || findDuplicate({ fileHash: hash })?.what);
  if (sameFile) {
    progDone(item, "skipped");
    show("dup", `⏭️ <b>דולג: הקובץ הזה כבר קיים במערכת</b><br><small>${esc(sameFile)}</small>`, '<button class="ghost go-on">לקלוט בכל זאת</button>');
    const goOn = await new Promise((ok) => (el.querySelector(".go-on").onclick = () => ok(true)));
    if (!goOn) return;
    prog.total++;
    item.counted = false;
    body.innerHTML = '<div class="status"><span class="label">ממתין…</span><div class="bar"><i></i></div></div>';
  }
  if (hash) inFlight.set(hash, path);

  // Read; a file that can't be read is still saved, so it can be opened and filled in by hand.
  let text = "", preview = "", failed = "";
  try {
    ({ text, preview } = await oneAtATime(() => readFile(file, status)));
  } catch (e) {
    failed = e.message || "שגיאה בקריאה";
  }
  if (preview) {
    el.querySelector(".thumb").innerHTML = `<img src="${preview}" alt="">`;
    el.querySelector(".thumb").onclick = () => zoom(preview);
  } else {
    el.querySelector(".thumb").innerHTML = '<span class="soon">📄</span>';
  }
  const found = failed ? {} : parseText(text);
  const rec = {
    client: clientFor(found.customer), customer: found.customer || "",
    date: found.date || "", supplier: found.supplier || "", supplierId: found.supplierId || "",
    category: found.category || "", docType: found.docType || "", docNo: found.docNo || "",
    amount: found.amount ?? null, vat: found.vat ?? null, details: found.details || "",
    fileName: path, fileHash: hash,
  };
  const why = reviewReasons(rec, { noText: !failed && !text.trim(), failed });
  rec.status = failed ? "failed" : why.length ? "review" : "ok";
  rec.reviewWhy = why.join(" · ");

  try {
    const id = await store.add(rec, preview);
    savedNow.push({ ...rec, id });
    inFlight.delete(hash);
    progDone(item, rec.status === "ok" ? "ok" : "review");
    const summary = [rec.client || "ללא לקוח", rec.supplier, showDate(rec.date), rec.amount ? fmt(rec.amount) : ""].filter(Boolean).map(esc).join(" · ");
    const open = `<button class="${rec.status === "ok" ? "ghost" : "primary"} open-it">${rec.status === "ok" ? "פתיחה" : "פתיחה ובדיקה"}</button>`;
    if (rec.status === "ok") show("saved", `✅ <b>נשמר</b> · ${summary}`, open);
    else show("review", `⚠️ <b>נשמר לבדיקה</b> · ${summary}<br><small>${esc(rec.reviewWhy)}</small>`, open);
    el.querySelector(".open-it").onclick = () => openEntry(id, rec);
  } catch (e) {
    inFlight.delete(hash);
    progDone(item, "failed");
    show("failed", `❌ <b>השמירה נכשלה</b> · ${esc(e.message)}`);
  }
}

function zoom(src) {
  $("imgBig").src = src;
  $("imgDlg").showModal();
}

// ---------- documents list ----------

let sortDir = -1;
["search", "clientFilter", "catFilter", "monthFilter", "reviewOnly"].forEach((id) => $(id).addEventListener("input", renderTable));
document.querySelector("th.sort").onclick = () => { sortDir = -sortDir; renderTable(); };

function fillSelect(sel, values, allLabel) {
  const cur = sel.value;
  sel.innerHTML = `<option value="">${allLabel}</option>` + values.map((v) => `<option>${esc(v)}</option>`).join("");
  sel.value = values.includes(cur) ? cur : "";
}

function renderAll() {
  markDuplicates();
  renderClientPickers();
  if (client === null) return;
  const names = clientNames();
  const cats = [...new Set([...CATEGORY_NAMES, ...records.map((r) => r.category).filter(Boolean)])];
  $("catList").innerHTML = cats.map((c) => `<option value="${esc(c)}">`).join("");
  fillSelect($("clientFilter"), names, "כל הלקוחות");
  fillSelect($("sumClient"), names, "כל הלקוחות");
  fillSelect($("catFilter"), [...new Set(records.filter(inScope).map((r) => r.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, "he")), "כל סוגי השירות");
  const years = [...new Set(records.filter(inScope).map((r) => (r.date || "").slice(0, 4)).filter(Boolean))].sort().reverse();
  const curYear = $("sumYear").value;
  $("sumYear").innerHTML = years.map((y) => `<option>${y}</option>`).join("") || `<option>${new Date().getFullYear()}</option>`;
  if (years.includes(curYear)) $("sumYear").value = curYear;
  const review = records.filter((r) => inScope(r) && needsReview(r)).length;
  $("reviewNote").hidden = !review;
  $("reviewCount").textContent = review;
  $("reviewBadge").hidden = !review;
  $("reviewBadge").textContent = review;
  if (!review) $("reviewOnly").checked = false;
  renderTable();
  renderSummary();
}

// id -> why it looks like another saved record. Recomputed whenever the records change.
let dupOf = new Map();
function markDuplicates() {
  dupOf = new Map();
  for (let i = 0; i < records.length; i++)
    for (let j = i + 1; j < records.length; j++) {
      const why = dupReason(records[i], records[j]);
      if (!why) continue;
      dupOf.set(records[i].id, `${why}, כמו: ${describe(records[j])}`);
      dupOf.set(records[j].id, `${why}, כמו: ${describe(records[i])}`);
    }
}

function filtered() {
  const q = $("search").value.trim().toLowerCase();
  const who = $("clientFilter").value, cat = $("catFilter").value, month = $("monthFilter").value, reviewOnly = $("reviewOnly").checked;
  return records.filter((r) => inScope(r) && (!reviewOnly || needsReview(r)) &&
    (!who || r.client === who) && (!cat || r.category === cat) && (!month || (r.date || "").startsWith(month)) &&
    (!q || [r.supplier, r.supplierId, r.details, r.docNo, r.client, r.customer, r.category, r.fileName].some((v) => String(v || "").toLowerCase().includes(q))))
    .sort((a, b) => sortDir * (a.date || "").localeCompare(b.date || ""));
}

function statusTag(r) {
  if (r.status === "failed") return `<span class="tag bad" title="${esc(r.reviewWhy)}">❌ לא נקרא</span> `;
  if (r.status === "review") return `<span class="tag warn" title="${esc(r.reviewWhy)}">⚠️ לבדיקה</span> `;
  if (dupOf.has(r.id)) return `<span class="tag warn" title="${esc(dupOf.get(r.id))}">⚠️ כפול</span> `;
  return "";
}

function renderTable() {
  const rows = filtered();
  $("sortArrow").textContent = sortDir < 0 ? "▼" : "▲";
  $("rows").innerHTML = rows.map((r) => `<tr data-id="${r.id}"${needsReview(r) ? ' class="dup"' : ""}>
    <td class="num">${showDate(r.date)}</td>
    <td>${esc(r.client) || '<span class="soon">ללא</span>'}</td>
    <td>${statusTag(r)}${esc(r.supplier) || `<span class="soon">${esc(r.fileName)}</span>`}${r.details ? `<small>${esc(r.details)}</small>` : ""}</td>
    <td>${r.category ? `<span class="tag">${esc(r.category)}</span>` : ""}</td>
    <td>${esc(r.docType)}${r.docNo ? `<small>מס׳ ${esc(r.docNo)}</small>` : ""}</td>
    <td class="num">${r.vat ? fmt(r.vat) : ""}</td>
    <td class="num">${r.amount ? fmt(r.amount) : ""}</td></tr>`).join("");
  $("rows").querySelectorAll("tr").forEach((tr) => (tr.onclick = () => openEntry(tr.dataset.id)));
  const sum = (k) => round2(rows.reduce((s, r) => s + (r[k] || 0), 0));
  $("shownSum").textContent = fmt(sum("amount"));
  $("shownVat").textContent = fmt(sum("vat"));
  $("sumCount").textContent = rows.length;
  $("sumTotal").textContent = fmt(sum("amount"));
  $("sumVat").textContent = fmt(sum("vat"));
  $("sumNet").textContent = fmt(round2(sum("amount") - sum("vat")));
  $("emptyMsg").hidden = records.some(inScope);
}

// ---------- one document: see it, fix it, approve it ----------

let editing = null;
async function openEntry(id, fallback) {
  const r = records.find((x) => x.id === id) || (fallback && { ...fallback, id });
  if (!r) return;
  editing = id;
  const box = $("dlgFields");
  box.innerHTML = fieldsHtml(r);
  bindFields(box);
  const why = [r.reviewWhy, dupOf.get(id) && `ייתכן כפילות: ${dupOf.get(id)}`].filter(Boolean).join(" · ");
  $("dlgTitle").textContent = r.status === "failed" ? "מסמך שלא נקרא: מלאו ידנית" : needsReview(r) ? "מסמך לבדיקה" : "עריכת מסמך";
  $("dlgWhy").hidden = !why;
  $("dlgWhy").textContent = why ? `⚠️ ${why}` : "";
  $("dlgFileName").textContent = r.fileName || "";
  $("dlgPreview").innerHTML = '<p class="soon">טוען תמונה…</p>';
  $("entryDlg").showModal();
  const src = await store.preview(id);
  if (editing !== id) return;
  $("dlgPreview").innerHTML = src
    ? `<img src="${src}" alt=""><small class="soon">לחיצה על התמונה מגדילה אותה</small>`
    : `<p class="soon">אין תמונה של המסמך. פתחו את הקובץ המקורי:<br><b class="ltr-path">${esc(r.fileName)}</b></p>`;
  const img = $("dlgPreview").querySelector("img");
  if (img) img.onclick = () => zoom(src);
}

// "שמירה" keeps whatever is still wrong marked for review; "שמירה ואישור" says the person checked it.
async function saveEntry(approve) {
  const rec = readFields($("dlgFields"));
  const why = approve ? [] : reviewReasons(rec, { exceptId: editing });
  rec.status = why.length ? "review" : "ok";
  rec.reviewWhy = why.join(" · ");
  try {
    await store.update(editing, rec);
    $("entryDlg").close();
    toast(why.length ? "נשמר. המסמך עדיין מסומן לבדיקה" : "נשמר ואושר");
  } catch (err) { toast("השמירה נכשלה: " + err.message); }
}
$("entryForm").onsubmit = (e) => { e.preventDefault(); saveEntry(false); };
$("approveBtn").onclick = () => saveEntry(true);
$("cancelBtn").onclick = () => $("entryDlg").close();
$("delBtn").onclick = async () => {
  if (!confirm("למחוק את המסמך?")) return;
  try { await store.remove(editing); $("entryDlg").close(); toast("נמחק"); }
  catch (err) { toast("המחיקה נכשלה: " + err.message); }
};

$("exportBtn").onclick = () => {
  const rows = filtered().map((r) => ({
    "תאריך": showDate(r.date), "לקוח": r.client, "ספק": r.supplier, "ח.פ / ע.מ": r.supplierId, "סוג שירות": r.category,
    "סוג מסמך": r.docType, "מספר מסמך": r.docNo, "פירוט": r.details,
    "לפני מע״מ": net(r), "מע״מ": r.vat || 0, "סכום כולל": r.amount || 0,
    "מצב": needsReview(r) ? "לבדיקה" : "תקין", "הערות": r.reviewWhy || "", "קובץ": r.fileName,
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  ws["!cols"] = [10, 16, 26, 12, 16, 16, 12, 30, 12, 10, 12, 8, 40, 24].map((wch) => ({ wch }));
  const wb = XLSX.utils.book_new();
  wb.Workbook = { Views: [{ RTL: true }] };
  XLSX.utils.book_append_sheet(wb, ws, "מסמכים");
  const who = client && client !== ALL ? `${client} ` : "";
  XLSX.writeFile(wb, `מסמכים ${who}${new Date().toISOString().slice(0, 10)}.xlsx`);
};

// ---------- summary ----------

["sumClient", "sumYear"].forEach((id) => $(id).addEventListener("input", renderSummary));
const MONTH_NAMES = ["ינו׳", "פבר׳", "מרץ", "אפר׳", "מאי", "יוני", "יולי", "אוג׳", "ספט׳", "אוק׳", "נוב׳", "דצמ׳"];

function bars(title, map, limit = 12) {
  const list = [...map].sort((a, b) => b[1] - a[1]).slice(0, limit);
  const max = Math.max(1, ...list.map(([, v]) => v));
  return `<div><h3>${title}</h3>${list.map(([k, v]) => `<div class="barrow"><span>${esc(k)}</span><b class="num">${fmt(v)}</b>
    <div class="track"><i style="width:${(v / max) * 100}%"></i></div></div>`).join("") || '<p class="soon">אין נתונים</p>'}</div>`;
}

function renderSummary() {
  const year = $("sumYear").value, who = $("sumClient").value;
  const rows = records.filter((r) => inScope(r) && (r.date || "").startsWith(year) && (!who || r.client === who));
  const add = (m, k, v) => m.set(k, round2((m.get(k) || 0) + v));
  const byCat = new Map(), bySup = new Map();
  const months = Array.from({ length: 12 }, () => ({ amount: 0, vat: 0, n: 0 }));
  for (const r of rows) {
    add(byCat, r.category || "ללא סיווג", r.amount || 0);
    add(bySup, r.supplier || "ללא ספק", r.amount || 0);
    const m = months[+r.date.slice(5, 7) - 1];
    m.amount += r.amount || 0; m.vat += r.vat || 0; m.n++;
  }
  const tot = months.reduce((s, m) => ({ amount: s.amount + m.amount, vat: s.vat + m.vat, n: s.n + m.n }), { amount: 0, vat: 0, n: 0 });
  $("summaryBody").innerHTML = `
    <div class="tablewrap months"><table>
      <thead><tr><th>חודש</th>${MONTH_NAMES.map((m) => `<th>${m}</th>`).join("")}<th>סה״כ</th></tr></thead>
      <tbody>
        <tr><td>מסמכים</td>${months.map((m) => `<td>${m.n || ""}</td>`).join("")}<td>${tot.n}</td></tr>
        <tr><td>מע״מ</td>${months.map((m) => `<td class="num">${m.vat ? fmt(round2(m.vat)) : ""}</td>`).join("")}<td class="num">${fmt(round2(tot.vat))}</td></tr>
        <tr><td>סכום</td>${months.map((m) => `<td class="num">${m.amount ? fmt(round2(m.amount)) : ""}</td>`).join("")}<td class="num">${fmt(round2(tot.amount))}</td></tr>
      </tbody></table></div>
    <div class="sum-grid" style="margin-top:18px">${bars("לפי סוג שירות", byCat)}${bars("ספקים מובילים", bySup, 10)}</div>`;
}

// ---------- sharing (owners only) ----------

let unsubAccess = null;
$("shareBtn").onclick = () => {
  unsubAccess ||= store.watchAccess((emails) => {
    $("shareList").innerHTML = emails.map((e) => `<li><span dir="ltr">${esc(e)}</span><button type="button" class="ghost" data-e="${esc(e)}">הסרה</button></li>`).join("")
      || '<li class="soon">עוד לא שותף אף אחד</li>';
    $("shareList").querySelectorAll("button").forEach((b) => (b.onclick = () => store.removeAccess(b.dataset.e)));
  });
  $("shareDlg").showModal();
};
$("shareAdd").onclick = async () => {
  const email = $("shareEmail").value.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast("כתובת מייל לא תקינה"); return; }
  try { await store.addAccess(email); $("shareEmail").value = ""; toast("נוסף. שלחו לו את הקישור לאתר."); }
  catch (e) { toast("ההוספה נכשלה: " + e.message); }
};
