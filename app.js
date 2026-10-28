import { firebaseConfig, OWNER_EMAILS } from "./firebase-config.js";
import { readFile, parseText, CATEGORY_NAMES, DOC_TYPE_NAMES, READABLE, MIME, rotatePreview, rereadPreview } from "./extract.js?v=12";
import { SHEET_EXT, readWorkbook, tableRows } from "./sheets.js?v=1";
import { EXPENSE_ACCOUNTS, OWNER_ACCOUNT, accountName, accountOf, suggestAccount } from "./accounts.js?v=5";
import { fillFromPath } from "./recheck.js?v=3";
import { parseComparative, comparativeFromDocs, buildFiling, filingSheet, comparativeSheet, lineOf } from "./report.js?v=1";

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
    savePreview: (id, dataUrl) => fs.setDoc(fs.doc(db, "previews", id), { dataUrl }),
    async allowed(email) {
      if (OWNER_EMAILS.includes(email)) return true;
      try { return (await fs.getDoc(fs.doc(db, "access", email.toLowerCase()))).exists(); } catch { return false; }
    },
    watchClients: (cb, onErr) => fs.onSnapshot(fs.collection(db, "clients"), (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))), onErr),
    addClient: (name) => fs.addDoc(fs.collection(db, "clients"), { name, createdAt: fs.serverTimestamp(), createdBy: auth.currentUser.email }),
    async removeClient(name) {
      const snap = await fs.getDocs(fs.query(fs.collection(db, "clients"), fs.where("name", "==", name)));
      for (const d of snap.docs) await fs.deleteDoc(d.ref);
    },
    watchAccess: (cb) => fs.onSnapshot(fs.collection(db, "access"), (snap) => cb(snap.docs.map((d) => d.id))),
    addAccess: (email) => fs.setDoc(fs.doc(db, "access", email), { addedAt: fs.serverTimestamp(), addedBy: auth.currentUser.email }),
    removeAccess: (email) => fs.deleteDoc(fs.doc(db, "access", email)),
    // A client's filing report for a year: reports/{id}, the comparative lines and the details around them.
    async getReport(id) { return (await fs.getDoc(fs.doc(db, "reports", id))).data() || null; },
    saveReport: (id, data) => fs.setDoc(fs.doc(db, "reports", id), { ...data, updatedAt: fs.serverTimestamp(), updatedBy: auth.currentUser.email }),
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
    async savePreview(id, dataUrl) { localStorage.setItem(PKEY + id, dataUrl); },
    watchClients(cb) { const f = () => cb(readJson(CKEY)); clientListeners.add(f); f(); return () => clientListeners.delete(f); },
    async addClient(name) {
      localStorage.setItem(CKEY, JSON.stringify([...readJson(CKEY), { id: Date.now().toString(36), name }]));
      clientListeners.forEach((f) => f());
    },
    async removeClient(name) {
      localStorage.setItem(CKEY, JSON.stringify(readJson(CKEY).filter((c) => c.name !== name)));
      clientListeners.forEach((f) => f());
    },
    async getReport(id) { try { return JSON.parse(localStorage.getItem("fairy-report-" + id)); } catch { return null; } },
    async saveReport(id, data) { localStorage.setItem("fairy-report-" + id, JSON.stringify(data)); },
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
  $("logoutBtn").hidden = $("homeLogout").hidden = !CLOUD;
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

// The photo always comes first; the app opens only after its computer screen is clicked ("knocked"),
// even for someone still signed in from last time. A redirect sign-in reloads the page, so the knock
// is kept across it.
let knocked = false, admitted = false;
try { knocked = sessionStorage.getItem("fairy-knock") === "1"; sessionStorage.removeItem("fairy-knock"); } catch {}

if (CLOUD) {
  const { auth, fa } = store;
  $("googleBtn").onclick = async () => {
    $("loginErr").textContent = "";
    knocked = true;
    if (admitted) return enterApp();
    try { await fa.signInWithPopup(auth, new fa.GoogleAuthProvider()); }
    catch (e) {
      if (e.code === "auth/popup-blocked") {
        try { sessionStorage.setItem("fairy-knock", "1"); } catch {}
        return fa.signInWithRedirect(auth, new fa.GoogleAuthProvider());
      }
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
    admitted = false;
    if (!u) { knocked = false; return showLogin(); }
    if (!(await store.allowed(u.email))) {
      await fa.signOut(auth);
      return showLogin(`החשבון ${u.email} לא מורשה. בקשו מהבעלים להוסיף אותו בשיתוף.`);
    }
    admitted = true;
    if (knocked) enterApp();
    else showLogin();
  });
} else {
  $("googleBtn").onclick = enterApp;
  showLogin();
}

// ---------- clients ----------
// After signing in a dropdown of the clients (with how many documents each has and how many wait
// for review); the same dropdown sits in the side menu to switch at any time.

const clientNames = () => [...new Set([...clients.map((c) => c.name), ...records.map((r) => r.client)].filter(Boolean))]
  .sort((a, b) => a.localeCompare(b, "he"));
const lastClient = () => { try { return localStorage.getItem("fairy-last-client") || ""; } catch { return ""; } };
const needsReview = (r) => r.status === "review" || r.status === "failed" || dupOf.has(r.id);

// The client lists show the names only.
function clientOptions(selected) {
  const opt = (value, text) => `<option value="${esc(value)}"${value === selected ? " selected" : ""}>${esc(text)}</option>`;
  return opt(ALL, "כל הלקוחות") + clientNames().map((n) => opt(n, n)).join("")
    + (records.some((r) => !r.client) ? opt("", "לא שויכו ללקוח") : "");
}

function showClients() {
  $("appView").hidden = true;
  $("clientView").hidden = false;
  $("clientSelect").innerHTML = "";
  renderClientPickers();
  $("clientSelect").focus();
}

function renderClientPickers() {
  // On the home page a choice already made in the dropdown stays when the data refreshes.
  const pick = $("clientSelect").value && !$("clientView").hidden ? $("clientSelect").value : (client ?? (lastClient() || ALL));
  $("clientSelect").innerHTML = clientOptions(pick);
  renderHome();
  if (client !== null) $("navClient").innerHTML = clientOptions(client);
  // Upload with "all clients": each document goes to the client named on it, or to one picked here.
  $("uploadClient").innerHTML = '<option value="">🔎 לפי שם הלקוח שבמסמך</option>'
    + clientNames().map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
}

// ---------- home page ----------
// A greeting by the time of day, and the way in: pick a client.

function renderHome() {
  if ($("clientView").hidden) return;
  const h = new Date().getHours();
  const hello = h < 5 ? "לילה טוב" : h < 12 ? "בוקר טוב" : h < 17 ? "צהריים טובים" : h < 21 ? "ערב טוב" : "לילה טוב";
  // Google gives the name as it is in the account (often in English); these people are greeted in Hebrew.
  const HEBREW_NAMES = { "einatgavish1@gmail.com": "עינת" };
  const first = HEBREW_NAMES[user?.email] || (user?.displayName || "").split(" ")[0];
  $("homeHello").textContent = first ? `${hello}, ${first}` : hello;
}
const homeGo = (view) => {
  chooseClient($("clientSelect").value);
  showView(view);
};
$("homeBtn").onclick = showClients;
$("homeLogout").onclick = () => $("logoutBtn").click();

// "כניסה" opens the client's journal entries.
$("clientForm").onsubmit = (e) => { e.preventDefault(); homeGo("journal"); };
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
// Every document of every client, in the list.
$("allDocsBtn").onclick = () => {
  if (client !== ALL) chooseClient(ALL);
  $("reviewOnly").checked = false;
  $("search").value = "";
  renderTable();
  showView("docs");
};
$("addClientBtn").onclick = async () => {
  const name = await addClient(prompt("שם הלקוח החדש:") || "");
  if (name) chooseClient(name);
};

// Deleting a client takes all their documents with them, for good: the name has to be typed to confirm.
$("delClientBtn").onclick = async () => {
  if (!client || client === ALL) return;
  const name = client;
  const docs = records.filter((r) => r.client === name);
  const typed = prompt(`מחיקת הלקוח "${name}" ו-${docs.length} המסמכים שלו. אי אפשר לשחזר אחרי המחיקה.\n\nכדי לאשר, הקלידו את שם הלקוח:`);
  if (typed === null) return;
  if (typed.trim() !== name) { toast("השם לא תואם. הלקוח לא נמחק"); return; }
  let failed = 0;
  for (const [i, r] of docs.entries()) {
    try { await store.remove(r.id); previewCache.delete(r.id); } catch { failed++; }
    if (docs.length > 5 && i % 5 === 4) toast(`מוחק מסמכים… ${i + 1} מתוך ${docs.length}`);
  }
  if (failed) { toast(`${failed} מסמכים לא נמחקו, ולכן הלקוח נשאר. נסו שוב.`); return; }
  try { await store.removeClient(name); }
  catch (e) { toast("המסמכים נמחקו, אבל הלקוח עצמו לא: " + e.message); return; }
  try { if (localStorage.getItem("fairy-last-client") === name) localStorage.removeItem("fairy-last-client"); } catch {}
  toast(`הלקוח "${name}" נמחק עם ${docs.length} מסמכים`);
  chooseClient(ALL);
};

function chooseClient(name) {
  client = name;
  try { localStorage.setItem("fairy-last-client", name); } catch {}
  const all = name === ALL;
  const title = all ? "" : `· ${name || "לא שויכו ללקוח"}`;
  for (const id of ["pageClient", "pageClient2", "pageClient3", "pageClient4", "pageClient5"]) $(id).textContent = title;
  loadFiling();
  $("clientPick").hidden = !all;
  $("clientFixed").hidden = all;
  $("clientFixed").innerHTML = all ? "" : `המסמכים יישמרו ללקוח: <b>${esc(name || "ללא שיוך")}</b>`;
  $("clientFilter").hidden = $("sumClient").hidden = !all;
  $("delClientBtn").hidden = all || !name;
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
  { k: "account", label: "חשבון חובה (פקודות יומן)", options: () => EXPENSE_ACCOUNTS.map(([c, n]) => [c, `${c} · ${n}`]) },
  { k: "details", label: "פירוט", wide: true },
];

function fieldsHtml(v) {
  return FIELDS.map((f) => {
    const val = v[f.k] ?? "";
    let input;
    if (f.options) {
      // An option is a value, or [value, what is shown].
      const list = f.options().map((o) => (Array.isArray(o) ? o : [o, o]));
      const all = val && !list.some(([o]) => o === val) ? [[val, val], ...list] : list;
      input = `<select name="${f.k}"><option value=""></option>${all.map(([o, t]) => `<option value="${esc(o)}"${o === val ? " selected" : ""}>${esc(t)}</option>`).join("")}</select>`;
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
// The service type this supplier's other documents were given: the most common one, an approved
// document counting double ("" when the supplier has none yet).
function learnedCategory(r, exceptId) {
  if (!r.supplier && !r.supplierId) return "";
  const count = {}, seen = new Set();
  for (const x of [...records, ...savedNow]) {
    if (x.id === exceptId || seen.has(x.id) || !x.category || !sameSupplier(r, x)) continue;
    seen.add(x.id);
    count[x.category] = (count[x.category] || 0) + (x.status === "ok" ? 2 : 1);
  }
  return Object.entries(count).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
}

// Once a document is given a service type, the same supplier's documents still without one get it too,
// and are checked again (one that has nothing else wrong stops waiting for review).
async function spreadCategory(rec, fromId) {
  if (!rec.category || (!rec.supplier && !rec.supplierId)) return 0;
  const others = records.filter((x) => x.id !== fromId && !x.category && x.status !== "failed" && sameSupplier(rec, x));
  for (const x of others) {
    const upd = { ...x, category: rec.category };
    const why = reviewReasons(upd, { exceptId: x.id, noText: (x.reviewWhy || "").includes("לא נמצא טקסט") });
    await store.update(x.id, { category: rec.category, status: why.length ? "review" : "ok", reviewWhy: why.join(" · ") });
  }
  return others.length;
}

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
  for (const { file, path } of out) (SHEET_EXT.test(file.name) ? processSheet : processFile)(file, path, batch);
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
  if (kind) prog[kind]++;
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
  // A timer rather than requestAnimationFrame, which stops in a background tab: the percentage in
  // the tab's title keeps moving while the person works in another tab.
  if (renderProgress.timer) return;
  renderProgress.timer = setTimeout(() => {
    renderProgress.timer = 0;
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
  }, 120);
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
  // The same file again: one already in good order is skipped; one still waiting for review is read
  // again (the reading may do better now) and its record gets what the new reading finds.
  const existing = hash && !inFlight.get(hash) && records.find((r) => r.fileHash === hash);
  const reread = existing && needsReview(existing) ? existing : null;
  const sameFile = hash && !reread && (inFlight.get(hash) || findDuplicate({ fileHash: hash })?.what);
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
  let text = "", alt = "", preview = "", hint = "", failed = "";
  try {
    ({ text, alt = "", preview, hint = "" } = await oneAtATime(() => readFile(file, status)));
  } catch (e) {
    failed = e.message || "שגיאה בקריאה";
  }
  if (preview) {
    el.querySelector(".thumb").innerHTML = `<img src="${preview}" alt="">`;
    el.querySelector(".thumb").onclick = () => zoom(preview);
  } else {
    el.querySelector(".thumb").innerHTML = '<span class="soon">📄</span>';
  }
  const found = failed ? {} : parseText(text, hint, alt);
  let rec = {
    client: clientFor(found.customer), customer: found.customer || "",
    date: found.date || "", supplier: found.supplier || "", supplierId: found.supplierId || "",
    category: found.category || "", docType: found.docType || "", docNo: found.docNo || "",
    amount: found.amount ?? null, vat: found.vat ?? null, details: found.details || "",
    fileName: path, fileHash: hash,
    // the text as read, so the document can be checked again later without the file
    text: [text, alt].filter((t) => t && t.trim()).join("\n----\n").slice(0, 15000),
  };
  if (reread) {
    // What the new reading found wins over the old one; the client and an account chosen by hand stay.
    const empty = (v) => v === "" || v == null;
    const kept = Object.fromEntries(Object.keys(rec).filter((k) => empty(rec[k]) && !empty(reread[k])).map((k) => [k, reread[k]]));
    rec = { ...rec, ...kept, client: reread.client || rec.client };
    if (reread.accountBy === "hand") Object.assign(rec, { account: reread.account, accountBy: "hand" });
  }
  if (!rec.category) rec.category = learnedCategory(rec);
  // The date, the journal account and the service type from the folders and the file's name, where
  // the document itself did not tell them (the account by the kind of item, from all its text).
  fillFromPath(rec, `${text}\n${alt}`);
  const why = reviewReasons(rec, { exceptId: reread?.id, noText: !failed && !text.trim() && !alt.trim(), failed });
  rec.status = failed ? "failed" : why.length ? "review" : "ok";
  rec.reviewWhy = why.join(" · ");

  try {
    let id;
    if (reread) { id = reread.id; await store.update(id, rec); }
    else id = await store.add(rec, preview);
    savedNow.push({ ...rec, id });
    inFlight.delete(hash);
    progDone(item, rec.status === "ok" ? "ok" : "review");
    const summary = [rec.client || "ללא לקוח", rec.supplier, showDate(rec.date), rec.amount ? fmt(rec.amount) : ""].filter(Boolean).map(esc).join(" · ");
    const open = `<button class="${rec.status === "ok" ? "ghost" : "primary"} open-it">${rec.status === "ok" ? "פתיחה" : "פתיחה ובדיקה"}</button>`;
    const again = reread ? "נקרא מחדש ו" : "";
    if (rec.status === "ok") show("saved", `✅ <b>${again}נשמר</b> · ${summary}`, open);
    else show("review", `⚠️ <b>${again}נשמר לבדיקה</b> · ${summary}<br><small>${esc(rec.reviewWhy)}</small>`, open);
    el.querySelector(".open-it").onclick = () => openEntry(id, rec);
  } catch (e) {
    inFlight.delete(hash);
    progDone(item, "failed");
    show("failed", `❌ <b>השמירה נכשלה</b> · ${esc(e.message)}`);
  }
}

// An Excel or CSV file. A table of expenses becomes one document per row, each checked like any
// other document; a row already in the system (same file, same row) is skipped. A sheet that is not
// such a table is read as one document instead.
async function processSheet(file, path, batch) {
  let rows = null;
  try { rows = tableRows(await readWorkbook(file)); } catch { /* not a workbook this reader knows: try it as a document */ }
  if (!rows) return processFile(file, path, batch);

  const el = document.createElement("div");
  el.className = "item";
  el.innerHTML = `<div class="thumb"><span class="soon">📊</span></div>
    <div class="body"><span class="fname">${esc(path)}</span><div class="status"><span class="label">קולט שורות…</span><div class="bar"><i></i></div></div></div>`;
  batch.append(el);
  const item = {};
  progStep(item, 0);
  let hash = "";
  try { hash = await fingerprint(file); } catch {}
  const n = { ok: 0, review: 0, skipped: 0, failed: 0 };
  for (const [i, row] of rows.entries()) {
    const rowHash = hash && `${hash}#${row.ref}`;
    if (rowHash && findDuplicate({ fileHash: rowHash })) { n.skipped++; continue; }
    const rec = {
      client: clientFor(row.customer), customer: row.customer, date: row.date, supplier: row.supplier, supplierId: row.supplierId,
      category: row.category, docType: row.docType, docNo: row.docNo, amount: row.amount, vat: row.vat, details: row.details,
      fileName: `${path} › ${row.ref}`, fileHash: rowHash,
    };
    if (!rec.category) rec.category = learnedCategory(rec);
    fillFromPath(rec);
    const why = reviewReasons(rec);
    rec.status = why.length ? "review" : "ok";
    rec.reviewWhy = why.join(" · ");
    try {
      const id = await store.add(rec, "");
      savedNow.push({ ...rec, id });
      n[rec.status]++;
    } catch { n.failed++; }
    const p = (i + 1) / rows.length;
    el.querySelector(".bar i").style.width = Math.round(p * 100) + "%";
    el.querySelector(".label").textContent = `קולט שורה ${i + 1} מתוך ${rows.length}…`;
    progStep(item, p);
  }
  prog.ok += n.ok;
  prog.review += n.review;
  prog.skipped += n.skipped;
  prog.failed += n.failed;
  progDone(item, null);
  el.className = `item ${n.review || n.failed ? "review" : "saved"}`;
  el.querySelector(".body").innerHTML = `<span class="fname">${esc(path)}</span>
    <div class="result">📊 <b>${rows.length ? `נקלטו ${rows.length - n.skipped - n.failed} שורות מתוך ${rows.length}` : "לא נמצאו שורות בטבלה"}</b><br>
      <small>${[n.ok && `✅ ${n.ok} תקינות`, n.review && `⚠️ ${n.review} לבדיקה`, n.skipped && `⏭️ ${n.skipped} כבר היו במערכת`, n.failed && `❌ ${n.failed} לא נשמרו`].filter(Boolean).join(" · ")}</small></div>
    <div class="item-actions"><button class="ghost show-rows">הצגה ברשימה</button></div>`;
  el.querySelector(".show-rows").onclick = () => {
    $("search").value = path;
    $("reviewOnly").checked = false;
    renderTable();
    showView("docs");
  };
}

function zoom(src) {
  $("imgBig").src = src;
  $("imgDlg").showModal();
}

// ---------- documents list ----------

let sortDir = -1;
["search", "clientFilter", "catFilter", "typeFilter", "monthFilter", "reviewOnly"].forEach((id) => $(id).addEventListener("input", renderTable));

// The kind of file a document came from, by the extension of its file (an Excel row's file is the part before "›").
const FILE_TYPES = {
  pdf: { re: /\.pdf$/i, label: "PDF" },
  excel: { re: /\.(xlsx|xlsm|xls|csv|ods)$/i, label: "אקסל" },
  word: { re: /\.docx?$/i, label: "Word" },
  image: { re: /\.(jpe?g|jfif|pjpeg|png|webp|gif|bmp|avif|heic|heif|tiff?)$/i, label: "תמונה" },
};
function fileType(r) {
  const file = (r.fileName || "").split(" › ")[0];
  return Object.keys(FILE_TYPES).find((k) => FILE_TYPES[k].re.test(file)) || "";
}
const typeTag = (r) => { const t = fileType(r); return t ? `<span class="ftype ft-${t}">${FILE_TYPES[t].label}</span> ` : ""; };
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
  if (!rereading) $("rereadAll").hidden = !review;
  $("reviewCount").textContent = review;
  $("reviewBadge").hidden = !review;
  $("reviewBadge").textContent = review;
  if (!review) $("reviewOnly").checked = false;
  renderTable();
  renderSummary();
  renderJournal();
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
  const type = $("typeFilter").value;
  return records.filter((r) => inScope(r) && (!reviewOnly || needsReview(r)) &&
    (!who || r.client === who) && (!cat || r.category === cat) && (!month || (r.date || "").startsWith(month)) && (!type || fileType(r) === type) &&
    (!q || [r.supplier, r.supplierId, r.details, r.docNo, r.client, r.customer, r.category, r.fileName].some((v) => String(v || "").toLowerCase().includes(q))))
    .sort((a, b) => sortDir * (a.date || "").localeCompare(b.date || ""));
}

function statusTag(r) {
  if (r.status === "failed") return `<span class="tag bad" title="${esc(r.reviewWhy)}">❌ לא נקרא</span> `;
  if (r.status === "review") return `<span class="tag warn" title="${esc(r.reviewWhy)}">⚠️ לבדיקה</span> `;
  if (dupOf.has(r.id)) return `<span class="tag warn" title="${esc(dupOf.get(r.id))}">⚠️ כפול</span> `;
  return "";
}

// Documents ticked in the list, for deleting several at once.
const selected = new Set();
let shownIds = [];

function renderTable() {
  const rows = filtered();
  shownIds = rows.map((r) => r.id);
  for (const id of [...selected]) if (!records.some((r) => r.id === id)) selected.delete(id);
  $("sortArrow").textContent = sortDir < 0 ? "▼" : "▲";
  $("rows").innerHTML = rows.map((r) => `<tr data-id="${r.id}" class="${needsReview(r) ? "dup" : ""}${selected.has(r.id) ? " picked" : ""}">
    <td class="sel"><input type="checkbox" data-sel="${r.id}"${selected.has(r.id) ? " checked" : ""} aria-label="בחירה"></td>
    <td class="num">${showDate(r.date)}</td>
    <td>${esc(r.client) || '<span class="soon">ללא</span>'}</td>
    <td>${typeTag(r)}${statusTag(r)}${esc(r.supplier) || `<span class="soon">${esc(r.fileName)}</span>`}${r.details ? `<small>${esc(r.details)}</small>` : ""}</td>
    <td>${r.category ? `<span class="tag">${esc(r.category)}</span>` : ""}</td>
    <td>${esc(r.docType)}${r.docNo ? `<small>מס׳ ${esc(r.docNo)}</small>` : ""}</td>
    <td class="num">${r.vat ? fmt(r.vat) : ""}</td>
    <td class="num">${r.amount ? fmt(r.amount) : ""}</td>
    <td class="row-del"><button type="button" class="icon-del" data-del="${r.id}" title="מחיקת המסמך" aria-label="מחיקת המסמך">🗑️</button></td></tr>`).join("");
  syncSelection();
  showSide(shownIds.includes(current) ? current : null);
  const sum = (k) => round2(rows.reduce((s, r) => s + (r[k] || 0), 0));
  $("shownSum").textContent = fmt(sum("amount"));
  $("shownVat").textContent = fmt(sum("vat"));
  $("sumCount").textContent = rows.length;
  $("sumTotal").textContent = fmt(sum("amount"));
  $("sumVat").textContent = fmt(sum("vat"));
  $("sumNet").textContent = fmt(round2(sum("amount") - sum("vat")));
  $("emptyMsg").hidden = records.some(inScope);
}

// One click handler for the whole list: the tick box marks, the bin deletes, anywhere else shows the
// document in the side panel (on a phone, where there is no room beside the list, it opens it).
const wide = () => matchMedia("(min-width: 1100px)").matches;
$("rows").addEventListener("click", (e) => {
  const tr = e.target.closest("tr");
  if (!tr) return;
  const del = e.target.closest("[data-del]");
  if (del) { deleteDocs([del.dataset.del]); return; }
  if (e.target.closest("td.sel")) {
    const box = tr.querySelector("[data-sel]");
    if (e.target !== box) box.checked = !box.checked;
    box.checked ? selected.add(tr.dataset.id) : selected.delete(tr.dataset.id);
    tr.classList.toggle("picked", box.checked);
    syncSelection();
    return;
  }
  if (wide()) showSide(tr.dataset.id);
  else openEntry(tr.dataset.id);
});
$("rows").addEventListener("dblclick", (e) => {
  const tr = e.target.closest("tr");
  if (tr && !e.target.closest("td.sel, [data-del]")) openEntry(tr.dataset.id);
});
$("selAll").onchange = () => {
  for (const id of shownIds) $("selAll").checked ? selected.add(id) : selected.delete(id);
  renderTable();
};
$("bulkDelete").onclick = () => deleteDocs([...selected]);
$("bulkClear").onclick = () => { selected.clear(); renderTable(); };

function syncSelection() {
  const n = selected.size;
  $("bulkBar").hidden = !n;
  $("selCount").textContent = n === 1 ? "סומן מסמך אחד" : `סומנו ${n} מסמכים`;
  $("selAll").checked = shownIds.length > 0 && shownIds.every((id) => selected.has(id));
  $("selAll").indeterminate = !$("selAll").checked && shownIds.some((id) => selected.has(id));
}

// Deleting removes the record and its picture for good, so it always asks first.
async function deleteDocs(ids) {
  if (!ids.length) return false;
  const one = ids.length === 1 && records.find((r) => r.id === ids[0]);
  const what = one ? `את המסמך "${[one.supplier || one.fileName, showDate(one.date), one.amount ? fmt(one.amount) : ""].filter(Boolean).join(" · ")}"` : `${ids.length} מסמכים`;
  if (!confirm(`למחוק ${what}?\nאי אפשר לשחזר אחרי המחיקה.`)) return false;
  // After deleting the one on show, the panel moves on to the next document in the list.
  const next = ids.includes(current) ? shownIds.find((id, i) => i > shownIds.indexOf(current) && !ids.includes(id)) : current;
  let done = 0, failed = 0;
  for (const id of ids) {
    try { await store.remove(id); selected.delete(id); previewCache.delete(id); done++; }
    catch { failed++; }
    if (ids.length > 5) toast(`מוחק… ${done + failed} מתוך ${ids.length}`);
  }
  current = next ?? null;
  renderTable();
  toast(failed ? `נמחקו ${done}. ${failed} לא נמחקו` : done === 1 ? "המסמך נמחק" : `נמחקו ${done} מסמכים`);
  return !failed;
}

// ---------- the document beside the list ----------

let current = null;
const previewCache = new Map();
async function previewOf(id) {
  if (!previewCache.has(id)) previewCache.set(id, store.preview(id).catch(() => ""));
  return previewCache.get(id);
}

async function showSide(id) {
  current = id;
  document.querySelectorAll("#rows tr.current").forEach((tr) => tr.classList.remove("current"));
  const r = id && records.find((x) => x.id === id);
  $("sideEmpty").hidden = !!r;
  $("sideDoc").hidden = !r;
  if (!r) return;
  const tr = document.querySelector(`#rows tr[data-id="${id}"]`);
  tr?.classList.add("current");
  tr?.scrollIntoView({ block: "nearest" });
  const i = shownIds.indexOf(id);
  $("sidePos").textContent = `${i + 1} מתוך ${shownIds.length}`;
  $("sidePrev").disabled = i <= 0;
  $("sideNext").disabled = i >= shownIds.length - 1;
  const why = [r.reviewWhy, dupOf.get(id) && `ייתכן כפילות: ${dupOf.get(id)}`].filter(Boolean).join(" · ");
  const line = (label, value) => (value ? `<div><small>${label}</small><b>${value}</b></div>` : "");
  $("sideInfo").innerHTML = `${why ? `<p class="dup-warn">⚠️ ${esc(why)}</p>` : '<p class="side-ok">✅ תקין</p>'}
    <div class="side-grid">
      ${line("לקוח", esc(r.client))}${line("ספק", esc(r.supplier))}${line("תאריך", showDate(r.date))}
      ${line("סכום", r.amount ? fmt(r.amount) : "")}${line("מע״מ", r.vat ? fmt(r.vat) : "")}${line("סוג שירות", esc(r.category))}
      ${line("מסמך", esc([r.docType, r.docNo && `מס׳ ${r.docNo}`].filter(Boolean).join(" ")))}${line("שם במסמך", esc(r.customer))}
    </div>
    <p class="side-file">${typeTag(r)}<span class="ltr-path">${esc(r.fileName)}</span></p>`;
  $("sideImg").innerHTML = '<p class="soon">טוען את המסמך…</p>';
  const src = await previewOf(id);
  if (current !== id) return;
  $("sideImg").innerHTML = src
    ? `<img src="${src}" alt="המסמך" title="לחיצה מגדילה">`
    : `<p class="soon">אין תמונה של המסמך${/›/.test(r.fileName) ? " (שורה מקובץ אקסל)" : ""}.</p>`;
  const img = $("sideImg").querySelector("img");
  if (img) img.onclick = () => zoom(src);
  // The next one is likely to be looked at next: fetch it ahead.
  if (shownIds[i + 1]) previewOf(shownIds[i + 1]);
}
const step = (d) => { const i = shownIds.indexOf(current) + d; if (shownIds[i]) showSide(shownIds[i]); };
$("sidePrev").onclick = () => step(-1);
$("sideNext").onclick = () => step(1);
$("sideEdit").onclick = () => current && openEntry(current);
$("sideRotate").onclick = async () => { if (current) turnPicture(current, await previewOf(current)); };
$("sideDelete").onclick = () => current && deleteDocs([current]);
// ↑ ↓ move through the list, Enter opens the document for editing.
document.addEventListener("keydown", (e) => {
  if (!document.querySelector('.view-panel[data-view="docs"]').classList.contains("view-active")) return;
  if (document.querySelector("dialog[open]") || /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName)) return;
  if (e.key === "ArrowDown") { e.preventDefault(); current ? step(1) : shownIds[0] && showSide(shownIds[0]); }
  else if (e.key === "ArrowUp") { e.preventDefault(); step(-1); }
  else if (e.key === "Enter" && current) { e.preventDefault(); openEntry(current); }
  else if (e.key === "Delete" && current) { e.preventDefault(); deleteDocs([current]); }
});

// ---------- one document: see it, fix it, approve it ----------

let editing = null;
async function openEntry(id, fallback) {
  const r = records.find((x) => x.id === id) || (fallback && { ...fallback, id });
  if (!r) return;
  editing = id;
  const box = $("dlgFields");
  box.innerHTML = fieldsHtml({ ...r, account: accountOf(r) });
  bindFields(box);
  const why = [r.reviewWhy, dupOf.get(id) && `ייתכן כפילות: ${dupOf.get(id)}`].filter(Boolean).join(" · ");
  $("dlgTitle").textContent = r.status === "failed" ? "מסמך שלא נקרא: מלאו ידנית" : needsReview(r) ? "מסמך לבדיקה" : "עריכת מסמך";
  $("dlgWhy").hidden = !why;
  $("dlgWhy").textContent = why ? `⚠️ ${why}` : "";
  $("dlgFileName").textContent = r.fileName || "";
  $("dlgPreview").innerHTML = '<p class="soon">טוען תמונה…</p>';
  $("entryDlg").showModal();
  const src = await previewOf(id);
  if (editing !== id) return;
  dialogPicture(id, src, r);
}

// The document's picture in the dialog, with turning it and reading it again.
function dialogPicture(id, src, r) {
  if (!src) {
    $("dlgPreview").innerHTML = `<p class="soon">אין תמונה של המסמך. פתחו את הקובץ המקורי:<br><b class="ltr-path">${esc(r.fileName)}</b></p>`;
    return;
  }
  const full = $("entryDlg").classList.contains("full");
  $("dlgPreview").innerHTML = `
    <div class="pic-zoom" ${full ? "" : "hidden"}>
      <button type="button" class="ghost" data-zoom="out" title="הקטנה">−</button>
      <span class="zoom-level"></span>
      <button type="button" class="ghost" data-zoom="in" title="הגדלה">+</button>
      <button type="button" class="ghost" data-zoom="fit" title="התאמה לרוחב">↔ התאמה</button>
      <span class="grow"></span>
      <button type="button" class="ghost" data-zoom="exit" title="חזרה לחלון הרגיל">⤡ חזרה</button>
    </div>
    <div class="pic-frame"><img src="${src}" alt="" draggable="false"></div>
    <div class="pic-tools">
      <button type="button" class="ghost" id="dlgRotate" title="סיבוב רבע סיבוב עם כיוון השעון">↻ סיבוב</button>
      <button type="button" class="ghost" id="dlgReread" title="קריאת הפרטים מהתמונה, כפי שהיא מוצגת עכשיו">📖 קריאה מחדש</button>
    </div>
    <small class="soon">${full ? "גלגלת עם Ctrl מגדילה ומקטינה, וגרירה מזיזה את התמונה."
      : "לחיצה על התמונה פורשת את החלון על כל המסך: התמונה בחצי אחד והפרטים בחצי השני."}</small>`;
  pictureZoom(full);
  $("dlgRotate").onclick = async () => {
    const turned = await turnPicture(id, src);
    if (turned && editing === id) dialogPicture(id, turned, r);
  };
  $("dlgReread").onclick = async () => {
    const btn = $("dlgReread");
    btn.disabled = true;
    try {
      const res = await rereadPreview(src, 0, (p) => (btn.textContent = `📖 קורא… ${Math.round(p * 100)}%`));
      const found = parseText(res.text, "", res.alt);
      // What the new reading found replaces what was read before; the client and the account stay.
      let n = 0;
      for (const k of ["date", "supplier", "supplierId", "customer", "category", "docType", "docNo", "amount", "vat", "details"]) {
        const input = $("dlgFields").querySelector(`[name=${k}]`);
        if (!input || found[k] === "" || found[k] == null) continue;
        input.value = found[k];
        n++;
      }
      $("dlgFields").dispatchEvent(new Event("input"));
      toast(n ? `נקראו ${n} פרטים מהתמונה. בדקו אותם ושמרו.` : "גם בכיוון הזה לא נקראו פרטים. נסו לסובב את התמונה.");
    } catch (e) { toast("הקריאה נכשלה: " + e.message); }
    btn.disabled = false;
    btn.textContent = "📖 קריאה מחדש";
  };
}

// Reads every document still waiting for review again from its saved picture: a picture taken on its
// side is turned upright first, and whatever the new reading finds fills what the record is missing.
// The documents that come out complete are no longer for review.
let rereading = false;
$("rereadAll").onclick = async () => {
  const list = records.filter((r) => inScope(r) && (r.status === "review" || r.status === "failed"));
  if (!list.length || rereading) return;
  if (!confirm(`לקרוא שוב ${list.length} מסמכים מהתמונות השמורות שלהם? זה לוקח כמה שניות לכל מסמך, ואפשר להמשיך לעבוד בינתיים.`)) return;
  rereading = true;
  const btn = $("rereadAll");
  btn.disabled = true;
  const KEYS = ["date", "supplier", "supplierId", "customer", "category", "docType", "docNo", "amount", "vat", "details"];
  const empty = (v) => v === "" || v == null;
  let done = 0, fixed = 0, turned = 0;
  for (const r of list) {
    btn.textContent = `📖 קורא מסמך ${done + 1} מתוך ${list.length}…`;
    try {
      const src = await previewOf(r.id);
      if (src) {
        const res = await rereadPreview(src, null);
        const found = parseText(res.text, "", res.alt);
        const upd = { ...r };
        for (const k of KEYS) if (empty(upd[k]) && !empty(found[k])) upd[k] = found[k];
        if (!upd.text) upd.text = [res.text, res.alt].filter(Boolean).join("\n----\n").slice(0, 15000);
        fillFromPath(upd, `${res.text}\n${res.alt}`);
        const why = reviewReasons(upd, { exceptId: r.id });
        upd.status = why.length ? "review" : "ok";
        upd.reviewWhy = why.join(" · ");
        const changes = Object.fromEntries(Object.keys(upd).filter((k) => k !== "id" && upd[k] !== r[k]).map((k) => [k, upd[k]]));
        if (res.turned) {
          await store.savePreview(r.id, res.preview);
          previewCache.set(r.id, Promise.resolve(res.preview));
          turned++;
        }
        if (Object.keys(changes).length) await store.update(r.id, changes);
        if (upd.status === "ok") fixed++;
      }
    } catch { /* this one stays as it was; carry on with the rest */ }
    done++;
  }
  rereading = false;
  btn.disabled = false;
  btn.textContent = "📖 קריאה חוזרת של המסמכים לבדיקה (כולל סיבוב)";
  toast(`נקראו שוב ${done} מסמכים${turned ? `, ${turned} סובבו` : ""}. ${fixed} מהם תקינים עכשיו.`);
};

// The picture in the document's window. In the normal window a click on it spreads the window over the
// whole screen, split in two: the picture on one half, the details on the other. There the picture can
// be enlarged and shrunk (the buttons, or the wheel with Ctrl), moved by dragging, and fitted back.
let picZoom = 1;
function pictureZoom(full) {
  const box = $("dlgPreview"), frame = box.querySelector(".pic-frame"), img = frame?.querySelector("img");
  if (!img) return;
  const apply = () => {
    img.style.width = full ? `${picZoom * 100}%` : "";
    const level = box.querySelector(".zoom-level");
    if (level) level.textContent = `${Math.round(picZoom * 100)}%`;
  };
  apply();
  if (!full) { img.onclick = () => setFull(true); return; }
  img.onclick = null;
  // Enlarging keeps the point under the mouse (or the middle) where it was.
  const zoomBy = (k, cx = frame.clientWidth / 2, cy = frame.clientHeight / 2) => {
    const rx = (frame.scrollLeft + cx) / frame.scrollWidth, ry = (frame.scrollTop + cy) / frame.scrollHeight;
    picZoom = Math.min(6, Math.max(0.3, picZoom * k));
    apply();
    frame.scrollLeft = rx * frame.scrollWidth - cx;
    frame.scrollTop = ry * frame.scrollHeight - cy;
  };
  box.querySelector(".pic-zoom").onclick = (e) => {
    const what = e.target.closest("[data-zoom]")?.dataset.zoom;
    if (what === "in") zoomBy(1.25);
    else if (what === "out") zoomBy(0.8);
    else if (what === "fit") { picZoom = 1; apply(); frame.scrollTo(0, 0); }
    else if (what === "exit") setFull(false);
  };
  frame.onwheel = (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const r = frame.getBoundingClientRect();
    zoomBy(e.deltaY < 0 ? 1.15 : 0.87, e.clientX - r.left, e.clientY - r.top);
  };
  frame.onpointerdown = (e) => {
    const sx = e.clientX, sy = e.clientY, left = frame.scrollLeft, top = frame.scrollTop;
    frame.setPointerCapture(e.pointerId);
    frame.classList.add("dragging");
    frame.onpointermove = (m) => { frame.scrollLeft = left - (m.clientX - sx); frame.scrollTop = top - (m.clientY - sy); };
    frame.onpointerup = () => { frame.onpointermove = null; frame.classList.remove("dragging"); };
  };
}
function setFull(on) {
  $("entryDlg").classList.toggle("full", on);
  picZoom = 1;
  const img = $("dlgPreview").querySelector(".pic-frame img");
  if (img && editing) dialogPicture(editing, img.getAttribute("src"), records.find((x) => x.id === editing) || {});
}
$("entryDlg").addEventListener("close", () => $("entryDlg").classList.remove("full"));

// Turns a document's saved picture a quarter turn clockwise and keeps it that way.
async function turnPicture(id, src) {
  try {
    const turned = await rotatePreview(src, 90);
    await store.savePreview(id, turned);
    previewCache.set(id, Promise.resolve(turned));
    if (current === id) showSide(id);
    return turned;
  } catch (e) { toast("הסיבוב נכשל: " + e.message); return ""; }
}

// "שמירה" keeps whatever is still wrong marked for review; "שמירה ואישור" says the person checked it.
async function saveEntry(approve) {
  const rec = readFields($("dlgFields"));
  // A journal account different from the one it had was picked by hand.
  const before = records.find((x) => x.id === editing);
  rec.accountBy = before && rec.account === accountOf(before) ? before.accountBy || "auto" : "hand";
  const why = approve ? [] : reviewReasons(rec, { exceptId: editing });
  rec.status = why.length ? "review" : "ok";
  rec.reviewWhy = why.join(" · ");
  try {
    const id = editing;
    await store.update(id, rec);
    $("entryDlg").close();
    const spread = await spreadCategory(rec, id);
    toast((why.length ? "נשמר. המסמך עדיין מסומן לבדיקה" : "נשמר ואושר")
      + (spread ? `. סוג השירות "${rec.category}" נוסף גם ל-${spread} מסמכים של אותו ספק` : ""));
  } catch (err) { toast("השמירה נכשלה: " + err.message); }
}
$("entryForm").onsubmit = (e) => { e.preventDefault(); saveEntry(false); };
$("approveBtn").onclick = () => saveEntry(true);
$("cancelBtn").onclick = () => $("entryDlg").close();
$("delBtn").onclick = async () => { if (await deleteDocs([editing])) $("entryDlg").close(); };

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

// ---------- journal entries (פקודות יומן) ----------
// Each document as one line, in the layout of the bookkeeping software's import (as in the tax-report
// workbook): four dates, supplier / details (24 characters at most), debit, credit, amount, reference,
// and the debit account's name. Every document is an expense: it debits its account and credits the
// owner's account (107000). The clients are exempt dealers, so the amount is the full amount paid.

// "2024-01-06" -> "06/01/24": day, month and year apart by slashes.
const jDate = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(2, 4)}` : "");
// The balance date (the fourth): a document from before the year counts from its first day.
const balanceDate = (iso, year) => (iso && year && iso < `${year}-01-01` ? `${year}-01-01` : iso);

function journalLines() {
  const year = $("jYear").value;
  return records.filter((r) => inScope(r) && (!year || (r.date || "").startsWith(year)))
    .map((r) => ({
      r, date: r.date || "", balance: balanceDate(r.date || "", year),
      details: (r.supplier || r.details || r.fileName || "").replace(/\s+/g, " ").trim().slice(0, 24),
      debit: accountOf(r), credit: OWNER_ACCOUNT, amount: r.amount || 0, ref: r.docNo || "",
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// The debit account and its name can both be clicked to change it; one picked by hand has a solid frame,
// one set from the document a dashed one.
const byHand = (r) => r.accountBy === "hand";
const pickable = (l, inner, cls) => `<button type="button" class="acc ${cls}${byHand(l.r) ? "" : " guessed"}" data-acc="${l.r.id}" title="${byHand(l.r) ? "נבחר ביד" : "נקבע לפי סוג הפריט"} · לחיצה לשינוי">${inner}</button>`;

function renderJournal() {
  const years = [...new Set(records.filter(inScope).map((r) => (r.date || "").slice(0, 4)).filter(Boolean))].sort().reverse();
  const cur = $("jYear").value;
  $("jYear").innerHTML = '<option value="">כל השנים</option>' + years.map((y) => `<option>${y}</option>`).join("");
  $("jYear").value = years.includes(cur) ? cur : (years[0] || "");
  const lines = journalLines();
  $("jRows").innerHTML = lines.map((l) => `<tr data-id="${l.r.id}"${needsReview(l.r) ? ' class="dup"' : ""}>
      <td class="num">${jDate(l.date)}</td><td class="num">${jDate(l.date)}</td><td class="num">${jDate(l.date)}</td><td class="num">${jDate(l.balance)}</td>
      <td>${needsReview(l.r) ? '<span title="מסמך לבדיקה">⚠️</span> ' : ""}${esc(l.details)}</td>
      <td class="num">${pickable(l, l.debit, "acc-code")}</td>
      <td class="num">${l.credit}</td>
      <td class="num">${l.amount.toLocaleString("he-IL", { maximumFractionDigits: 2 })}</td>
      <td class="num">${esc(l.ref)}</td>
      <td>${pickable(l, esc(accountName(l.debit)), "acc-name")}</td></tr>`).join("");
  $("jEmpty").hidden = lines.length > 0;
}
$("jYear").addEventListener("input", renderJournal);

// Clicking the account turns it into a list of the expense accounts; picking one saves it on the document.
$("jRows").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-acc]");
  if (btn) {
    const r = records.find((x) => x.id === btn.dataset.acc);
    if (!r) return;
    const cur = accountOf(r);
    const sel = document.createElement("select");
    sel.className = "acc-pick";
    sel.innerHTML = EXPENSE_ACCOUNTS.map(([c, n]) => `<option value="${c}"${c === cur ? " selected" : ""}>${c} · ${esc(n)}</option>`).join("");
    btn.replaceWith(sel);
    sel.focus();
    const done = async (save) => {
      if (save && sel.value !== cur) {
        try { await store.update(r.id, { account: sel.value, accountBy: "hand" }); toast(`החשבון עודכן ל-${sel.value} ${accountName(sel.value)}`); }
        catch (err) { toast("השמירה נכשלה: " + err.message); }
      }
      renderJournal();
    };
    sel.onchange = () => done(true);
    sel.onblur = () => done(false);
    return;
  }
  if (e.target.closest("select")) return;
  const tr = e.target.closest("tr[data-id]");
  if (tr) openEntry(tr.dataset.id);
});

// The same lines as an Excel sheet, laid out like the workbook: real dates shown as dd/mm/yy,
// the accounts and amounts as numbers.
$("jExport").onclick = () => {
  const lines = journalLines();
  if (!lines.length) { toast("אין מה לייצא"); return; }
  // Excel's own day number (days since 30-12-1899), so no time zone can move a date by a day.
  const toDate = (iso) => (iso ? (Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) - Date.UTC(1899, 11, 30)) / 864e5 : "");
  const aoa = [["הוצאות", "", "", "", "ספק / פרטים (מוגבל ל 24 תווים)", "חובה", "זכות", "סכום", "אסמכתא", "תאור חשבון חובה"]];
  for (const l of lines) {
    aoa.push([toDate(l.date), toDate(l.date), toDate(l.date), toDate(l.balance), l.details,
      +l.debit, +l.credit, l.amount, /^\d+$/.test(l.ref) ? +l.ref : l.ref, accountName(l.debit)]);
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  for (let r = 1; r < aoa.length; r++) {
    for (let c = 0; c < 4; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (cell && cell.t === "n") cell.z = "dd/mm/yy";
    }
    const sum = ws[XLSX.utils.encode_cell({ r, c: 7 })];
    if (sum && sum.t === "n") sum.z = Number.isInteger(sum.v) ? "#,##0" : "#,##0.00";
  }
  ws["!cols"] = [10, 10, 10, 10, 26, 9, 9, 11, 12, 22].map((wch) => ({ wch }));
  const wb = XLSX.utils.book_new();
  wb.Workbook = { Views: [{ RTL: true }] };
  XLSX.utils.book_append_sheet(wb, ws, "פקודות יומן");
  const who = client && client !== ALL ? `${client} ` : "";
  XLSX.writeFile(wb, `פקודות יומן ${who}${$("jYear").value || "כל השנים"}.xlsx`);
};

// ---------- filing report (דוח להגשה) ----------
// For one client and tax year: the comparative report (imported from the bookkeeping software's Excel,
// or put together from the documents here), and the filing report it adds up to. Saved per client and
// year with the client's ID and file number and the adjustment rates, so it opens as it was left.

let filing = null; // { client, year, idNumber, fileNo, carPct, mealPct, source, fileName, lines }
const reportId = (name, year) => `${name}__${year}`.replace(/[\/\s]+/g, "_");
const thisYear = new Date().getFullYear();

function filingYears() {
  const ys = new Set(records.filter(inScope).map((r) => +(r.date || "").slice(0, 4)).filter(Boolean));
  ys.add(thisYear - 1);
  if (filing?.year) ys.add(+filing.year);
  return [...ys].sort((a, b) => b - a);
}

async function loadFiling(year) {
  if (!client || client === ALL) { filing = null; renderFiling(); return; }
  year = +(year || $("fYear").value || thisYear - 1);
  const saved = await store.getReport(reportId(client, year)).catch(() => null);
  // A new year starts with the client's ID, file number and rates from last year's report.
  const last = saved ? null : await store.getReport(reportId(client, year - 1)).catch(() => null);
  filing = saved || { client, year, idNumber: last?.idNumber || "", fileNo: last?.fileNo || "", carPct: last?.carPct ?? 55,
    mealPct: last?.mealPct ?? 20, source: "", fileName: "", lines: [] };
  renderFiling();
}

async function saveFiling(note) {
  if (!filing) return;
  try {
    await store.saveReport(reportId(filing.client, filing.year), { ...filing, year: +filing.year });
    if (note) toast(note);
  } catch (e) { toast("השמירה נכשלה: " + e.message); }
}

function renderFiling() {
  const years = filingYears();
  const want = filing?.year || +$("fYear").value || thisYear - 1;
  $("fYear").innerHTML = years.map((y) => `<option${y === +want ? " selected" : ""}>${y}</option>`).join("");
  const none = !client || client === ALL;
  $("filingNeedClient").hidden = !none;
  $("filingMain").hidden = none;
  if (none || !filing) return;
  $("fId").value = filing.idNumber || "";
  $("fFileNo").value = filing.fileNo || "";
  $("fCar").value = filing.carPct;
  $("fMeal").value = filing.mealPct;
  $("fSource").textContent = !filing.lines.length ? "עוד אין דוח השוואתי לשנה הזו. מייבאים אותו מאקסל, או מחשבים מהמסמכים במערכת."
    : filing.source === "file" ? `נבנה מהקובץ: ${filing.fileName}` : "נבנה מהמסמכים במערכת";
  $("filingBody").innerHTML = filing.lines.length ? filingHtml() : "";
  $("compBox").hidden = !filing.lines.length;
  $("compBody").innerHTML = comparativeHtml();
}

const shekel = (n) => (n ? Math.round(n).toLocaleString("he-IL") : "-");
const signed = (n) => (n < 0 ? `(${Math.round(-n).toLocaleString("he-IL")})` : Math.round(n).toLocaleString("he-IL"));

// The filing report on screen as it looks in the workbook: the labels, the lines in the middle column,
// the totals in the last one.
function filingHtml() {
  const f = buildFiling(filing.lines, filing);
  const row = (label, b = "", d = "", cls = "") => `<tr class="${cls}"><td>${esc(label)}</td><td class="num">${b}</td><td class="num">${d}</td></tr>`;
  const y = filing.year;
  return `<div class="filing-sheet">
    <h3>${esc(filing.client)}   - תעודת זהות ${esc(filing.idNumber || "")}</h3>
    <h3>תיק מספר ${esc(filing.fileNo || "")}</h3>
    <h3 class="fs-title">דוח הכנסות והוצאות לשנת המס ${y}</h3>
    <table>
      <thead><tr><th></th><th class="num">שקלים חדשים</th><th class="num">שקלים חדשים</th></tr></thead>
      <tbody>
        ${row("הכנסות", "", shekel(f.income), "b line")}
        ${f.stock ? row("שינויים במלאי", shekel(f.stock)) : ""}
        ${row("קניות אחרות", shekel(f.purchases), "", "under-b")}
        ${row("עלות ההכנסות", "", shekel(f.cost), "b line")}
        ${row("רווח גולמי", "", shekel(f.gross), "b")}
        ${row("הוצאות  מכירה הנהלה וכלליות", "", "", "b gap")}
        ${f.expenses.map(([l, v], i) => row(l, shekel(v), "", i === f.expenses.length - 1 ? "under-b" : "")).join("")}
        ${row(" הוצאות מכירה הנהלה וכלליות", "", shekel(f.expenseTotal), "b line")}
        ${row(f.result < 0 ? "הפסד לשנה" : "רווח לשנה", "", signed(f.result), "b")}
        ${row("תאומים ", "", "", "b gap")}
        ${row(`הוצאות רכב (${filing.carPct}%)`, shekel(f.carAdj), "", "under-b")}
        ${row(`כיבודים (${filing.mealPct}%)`, shekel(f.mealAdj), "", "under-b")}
        ${row("", "", shekel(f.adjTotal), "line")}
        ${row(f.final < 0 ? `הפסד מעסק לשנת ${y} מקוזז מהכנסה משכר` : `רווח מעסק לשנת ${y}`, "", signed(f.final), "b total")}
      </tbody>
    </table></div>`;
}

// The comparative report it came from, each account with the filing line it went into.
function comparativeHtml() {
  if (!filing?.lines.length) return "";
  const money = (n) => (n || 0).toLocaleString("he-IL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `<div class="tablewrap"><table>
    <thead><tr><th>סעיף רווח והפסד</th><th>חשבון</th><th>תאור חשבון</th><th class="num">סכום השנה</th><th class="num">סכום בשנה שעברה</th><th>שורה בדוח להגשה</th></tr></thead>
    <tbody>${filing.lines.map((l) => `<tr><td>${esc(l.section)}</td><td class="num">${esc(l.code)}</td><td>${esc(l.name)}</td>
      <td class="num">${money(l.cur)}</td><td class="num">${money(l.prev)}</td><td><span class="tag">${esc(lineOf(l.code))}</span></td></tr>`).join("")}</tbody>
  </table></div>`;
}

$("fYear").addEventListener("input", () => loadFiling($("fYear").value));
for (const [id, key, isNum] of [["fId", "idNumber"], ["fFileNo", "fileNo"], ["fCar", "carPct", true], ["fMeal", "mealPct", true]]) {
  $(id).addEventListener("change", () => {
    if (!filing) return;
    filing[key] = isNum ? +$(id).value || 0 : $(id).value.trim();
    renderFiling();
    saveFiling("נשמר");
  });
}

$("fImport").onclick = () => $("fFile").click();
$("fFile").onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file || !filing) return;
  let parsed = null;
  try { parsed = parseComparative(await readWorkbook(file)); } catch {}
  if (!parsed) { toast("לא נמצא בקובץ דוח השוואתי (טבלה עם העמודות חשבון וסכום השנה)"); return; }
  if (parsed.year && +parsed.year !== +filing.year
      && !confirm(`הדוח בקובץ הוא לשנת ${parsed.year}, והשנה שנבחרה היא ${filing.year}. לשמור אותו לשנת ${parsed.year}?`)) return;
  const year = +(parsed.year || filing.year);
  const keep = { idNumber: filing.idNumber, fileNo: filing.fileNo, carPct: filing.carPct, mealPct: filing.mealPct };
  filing = { client, year, ...keep, source: "file", fileName: file.name, lines: parsed.lines };
  await saveFiling(`נקלט דוח השוואתי עם ${parsed.lines.length} חשבונות`);
  renderFiling();
};

$("fFromDocs").onclick = async () => {
  if (!filing) return;
  if (filing.lines.length && filing.source === "file"
      && !confirm("לשנה הזו כבר יש דוח השוואתי מקובץ. להחליף אותו בחישוב מהמסמכים במערכת?")) return;
  const lines = comparativeFromDocs(records.filter(inScope), +filing.year, accountOf, accountName);
  if (!lines.length) { toast(`אין מסמכים לשנת ${filing.year}`); return; }
  filing = { ...filing, source: "docs", fileName: "", lines };
  await saveFiling(`חושב מ-${lines.length} חשבונות של המסמכים`);
  renderFiling();
};

$("fExport").onclick = () => {
  if (!filing?.lines.length) { toast("אין עדיין דוח לייצא"); return; }
  const wb = XLSX.utils.book_new();
  wb.Workbook = { Views: [{ RTL: true }] };
  XLSX.utils.book_append_sheet(wb, filingSheet({ ...filing, f: buildFiling(filing.lines, filing) }), "דוח להגשה");
  XLSX.utils.book_append_sheet(wb, comparativeSheet(filing), "דוח השוואתי");
  XLSX.writeFile(wb, `${filing.client} דוח מס ${filing.year}.xlsx`);
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
