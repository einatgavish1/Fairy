import { firebaseConfig, OWNER_EMAILS, AI_READING } from "./firebase-config.js?v=2";
import { readFile, parseText, CATEGORY_NAMES, DOC_TYPE_NAMES, READABLE, MIME, rotatePreview, rereadPreview } from "./extract.js?v=16";
import { SHEET_EXT, readWorkbook, tableRows } from "./sheets.js?v=1";
import { EXPENSE_ACCOUNTS, OWNER_ACCOUNT, accountName, accountOf, suggestAccount } from "./accounts.js?v=6";
import { fillFromPath } from "./recheck.js?v=7";
import { parseComparative, comparativeFromDocs, buildFiling, filingSheet, comparativeSheet, lineOf } from "./report.js?v=3";

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
  const ff = await import(V + "firebase-functions.js");
  const readDocument = ff.httpsCallable(ff.getFunctions(app, "me-west1"), "readDocument", { timeout: 120000 });
  store = {
    auth, fa,
    // Access to the names and places of the files in the person's Google Drive (not their content).
    async driveToken() {
      const provider = new fa.GoogleAuthProvider();
      provider.addScope("https://www.googleapis.com/auth/drive.metadata.readonly");
      provider.setCustomParameters({ login_hint: auth.currentUser.email });
      const res = await fa.reauthenticateWithPopup(auth.currentUser, provider);
      return fa.GoogleAuthProvider.credentialFromResult(res)?.accessToken || "";
    },
    // Claude's reading of a document's picture (functions/index.js).
    aiRead: async (payload) => (await readDocument(payload)).data,
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
    // dealerLog: every setting of the client's dealer type, { dealer, from (YYYY-MM-DD, "" = from the start), at, by }
    addClient: (name, dealer) => fs.addDoc(fs.collection(db, "clients"), { name, dealer,
      dealerLog: [{ dealer, from: "", at: Date.now(), by: auth.currentUser.email }],
      createdAt: fs.serverTimestamp(), createdBy: auth.currentUser.email }),
    async setDealer(name, dealer, from, log) {
      const entry = { dealer, from, at: Date.now(), by: auth.currentUser.email };
      const snap = await fs.getDocs(fs.query(fs.collection(db, "clients"), fs.where("name", "==", name)));
      if (snap.empty) {
        await fs.addDoc(fs.collection(db, "clients"), { name, dealer, dealerLog: [...log, entry], createdAt: fs.serverTimestamp(), createdBy: auth.currentUser.email });
      }
      for (const d of snap.docs) await fs.updateDoc(d.ref, { dealer, dealerLog: [...log, entry] });
    },
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
    async addClient(name, dealer) {
      const dealerLog = [{ dealer, from: "", at: Date.now(), by: "" }];
      localStorage.setItem(CKEY, JSON.stringify([...readJson(CKEY), { id: Date.now().toString(36), name, dealer, dealerLog }]));
      clientListeners.forEach((f) => f());
    },
    async setDealer(name, dealer, from, log) {
      const all = readJson(CKEY);
      if (!all.some((c) => c.name === name)) all.push({ id: Date.now().toString(36), name });
      const dealerLog = [...log, { dealer, from, at: Date.now(), by: "" }];
      localStorage.setItem(CKEY, JSON.stringify(all.map((c) => (c.name === name ? { ...c, dealer, dealerLog } : c))));
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
// The client's other documents (kind "misc": a rent contract, form 106...) are kept apart from the expense
// documents, so nothing that works on expenses ever sees them.
let miscDocs = [];
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
  unsub = store.watch((all) => {
    records = all.filter((r) => r.kind !== "misc");
    miscDocs = all.filter((r) => r.kind === "misc");
    renderAll();
  }, denied);
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
  $("clientNameList").innerHTML = clientNames().map((n) => `<option value="${esc(n)}">`).join("");
  if ($("clientSearch").value.trim()) searchClients();
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

// Typing part of a name leaves only the matching clients in the list and picks the first of them;
// a name picked from the suggestions is chosen as is.
function searchClients() {
  const q = $("clientSearch").value.trim().toLowerCase(), sel = $("clientSelect");
  let first = null, exact = null;
  for (const o of sel.options) {
    const match = !q || (o.value !== ALL && o.text.toLowerCase().includes(q));
    o.hidden = !match;
    if (match && !first) first = o;
    if (q && o.text.toLowerCase() === q) exact = o;
  }
  const pick = exact || first;
  if (q && pick) sel.value = pick.value;
  $("clientSearch").classList.toggle("no-match", !!q && !first);
}
$("clientSearch").addEventListener("input", searchClients);

// "כניסה" opens the client's journal entries.
$("clientForm").onsubmit = (e) => {
  e.preventDefault();
  if ($("clientSearch").classList.contains("no-match")) { toast("לא נמצא לקוח בשם הזה"); return; }
  $("clientSearch").value = "";
  homeGo("journal");
};
$("navClient").onchange = () => chooseClient($("navClient").value);

// An exempt dealer (עוסק פטור) records each expense with its VAT; a licensed one (עוסק מורשה) claims the
// VAT back, so the journal puts it apart on the input-VAT account.
// A client's type can change from a date on (a growing business becomes licensed); every change is kept in
// dealerLog, and a document goes by the type its own date falls under.
function dealerLog(name) {
  const c = clients.find((x) => x.name === name);
  const log = Array.isArray(c?.dealerLog) && c.dealerLog.length ? c.dealerLog : [{ dealer: c?.dealer || "exempt", from: "", at: 0, by: "" }];
  return [...log].sort((a, b) => a.from.localeCompare(b.from) || a.at - b.at);
}
function dealerOf(name, date = new Date().toISOString().slice(0, 10)) {
  let dealer = "exempt";
  for (const e of dealerLog(name)) if (!e.from || !date || e.from <= date) dealer = e.dealer;
  return dealer;
}
const DEALER_NAMES = { exempt: "עוסק פטור", licensed: "עוסק מורשה" };

async function addClient(name, dealer = "exempt") {
  name = name.trim().replace(/\s+/g, " ");
  if (!name) return false;
  if (!clientNames().includes(name)) {
    try { await store.addClient(name, dealer); }
    catch (err) { toast("ההוספה נכשלה: " + err.message); return false; }
  }
  return name;
}
$("newClientForm").onsubmit = async (e) => {
  e.preventDefault();
  const name = await addClient($("newClientName").value, $("newClientDealer").value);
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
// A new client is added on the home page, where its type is chosen with it.
$("addClientBtn").onclick = () => { showClients(); $("newClientName").focus(); };

// Deleting a client takes all their documents with them, for good: the name has to be typed to confirm.
$("delClientBtn").onclick = async () => {
  if (!client || client === ALL) return;
  const name = client;
  const docs = records.filter((r) => r.client === name);
  // Two questions: is this the client to delete, and then the name typed to confirm it is for good.
  if (!(await askDelete("מחיקת לקוח", `למחוק את הלקוח "${name}" ואת ${docs.length} המסמכים שלו מהתוכנה?\nהקבצים המקוריים בדרייב ובמחשב לא יימחקו.`))) return;
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
  for (const id of ["pageClient", "pageClient2", "pageClient3", "pageClient4", "pageClient5", "pageClient6", "pageClient7"]) $(id).textContent = title;
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

// ---------- payments in a foreign currency ----------
// A document paid in dollars, euros or pounds is recorded in shekels at the Bank of Israel representative
// rate (שער יציג) of the payment day: the last rate published on or before it (none on weekends and
// holidays). The amount as paid, the rate and its day stay on the document, and a note shows them.
const FX = {
  "": { name: "₪ שקל", sign: "₪" },
  USD: { name: "$ דולר ארה״ב", sign: "$" },
  EUR: { name: "€ אירו", sign: "€" },
  GBP: { name: "£ לירה שטרלינג", sign: "£" },
};
const FX_CODES = Object.keys(FX);
const foreign = (r) => !!r.currency && r.currency !== "ILS" && !!FX[r.currency];
const BOI_PAGE = "https://www.boi.org.il/roles/markets/exchangerates/";
// The rates come from rates.json, published with the site (scripts/update-rates.mjs pulls them from the
// Bank of Israel, which does not answer a web page directly). -> { rate, day } or null.
let ratesFile = null;
async function boiRate(currency, date) {
  ratesFile ??= fetch("./rates.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const file = await ratesFile;
  if (!file) { ratesFile = null; return null; }
  const days = file.rates?.[currency];
  if (!days || !date || date > file.updated) return null;
  // the day itself, or the last day with a rate before it (none on weekends and holidays), up to two weeks back
  for (let i = 0; i <= 14; i++) {
    const day = new Date(Date.parse(date) - i * 864e5).toISOString().slice(0, 10);
    if (days[day]) return { rate: days[day], day };
  }
  return null;
}
const ratesUpdated = async () => (await ratesFile)?.updated || "";
// Fills a foreign-currency record's shekel amount (and VAT) from its amount as paid: at the rate typed
// by hand, or at the representative rate of its date. -> true when it has a rate.
async function convertCurrency(rec, { refetch = false } = {}) {
  if (!foreign(rec)) { Object.assign(rec, { currency: "", origAmount: null, rate: null, rateDate: "" }); return true; }
  if (rec.origAmount == null) return false;
  if ((refetch || !rec.rate) && rec.date) {
    const got = await boiRate(rec.currency, rec.date);
    if (got) Object.assign(rec, { rate: got.rate, rateDate: got.day });
  }
  if (!rec.rate) return false;
  if (!rec.rateDate) rec.rateDate = rec.date || "";
  rec.amount = round2(rec.origAmount * rec.rate);
  if (rec.origVat != null) rec.vat = round2(rec.origVat * rec.rate);
  return true;
}
const fxNote = (r) => (foreign(r) ? `💱 שולם ${FX[r.currency].sign}${fmt2(r.origAmount)} (${r.currency})${r.rate
  ? ` · שער יציג ${r.rate} ליום ${showDate(r.rateDate || r.date)} (בנק ישראל) · נרשם ₪${fmt2(r.amount)}` : " · חסר שער יציג"}` : "");
const fmt2 = (n) => (n == null ? "" : (+n).toLocaleString("he-IL", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

// ---------- the form fields of a document ----------

const FIELDS = [
  { k: "client", label: "לקוח", options: () => clientNames() },
  { k: "customer", label: "שם הלקוח כפי שמופיע במסמך" },
  { k: "date", label: "תאריך", type: "date", need: true },
  { k: "supplier", label: "ספק", need: true },
  { k: "supplierId", label: "ח.פ / ע.מ" },
  { k: "docType", label: "סוג מסמך", options: () => DOC_TYPE_NAMES },
  { k: "docNo", label: "מספר מסמך" },
  { k: "amount", label: "סכום כולל מע״מ (₪)", type: "number", need: true },
  { k: "vat", label: "מע״מ (₪)", type: "number" },
  // paid in a foreign currency: the amount as paid and the Bank of Israel representative rate of that day
  { k: "currency", label: "מטבע התשלום", options: () => FX_CODES.map((c) => [c, FX[c].name]) },
  { k: "origAmount", label: "סכום מט"ח", type: "number" },
  { k: "rate", label: "שער יציג", type: "number", exact: true },
  { k: "account", label: "חשבון חובה (פקודות יומן)", options: () => EXPENSE_ACCOUNTS.map(([c, n]) => [c, `${c} · ${n}`]) },
  // electricity, water, municipal tax, gas: the bill as paid, and the part of it recognised as the expense
  { k: "paid", label: "סכום ששולם (₪)", type: "number", home: true },
  { k: "pct", label: "אחוז הנחה (%)", type: "number", exact: true, step: 1, min: 0, max: 100, home: true },
  { k: "details", label: "פירוט", wide: true },
];

// The home's bills: only part of what was paid is the business's expense.
const HOME_ACCOUNTS = ["613003", "613004", "613005", "613006"];
const HOME_PCT = 25;
const isHome = (account) => HOME_ACCOUNTS.includes(account);

function fieldsHtml(v) {
  return FIELDS.map((f) => {
    const val = f.k === "pct" && isHome(v.account) && v.pct == null ? HOME_PCT : v[f.k] ?? "";
    let input;
    if (f.options) {
      // An option is a value, or [value, what is shown].
      const list = f.options().map((o) => (Array.isArray(o) ? o : [o, o]));
      const all = val && !list.some(([o]) => o === val) ? [[val, val], ...list] : list;
      input = `<select name="${f.k}"><option value=""></option>${all.map(([o, t]) => `<option value="${esc(o)}"${o === val ? " selected" : ""}>${esc(t)}</option>`).join("")}</select>`;
    } else {
      input = `<input name="${f.k}" type="${f.type || "text"}" value="${esc(val)}"${f.list ? ` list="${f.list}" autocomplete="off"` : ""}${f.type === "number" ? ` step="${f.step || (f.exact ? "any" : "0.01")}" inputmode="decimal" dir="ltr"` : ""}${f.min != null ? ` min="${f.min}" max="${f.max}"` : ""}>`;
    }
    return `<label class="${f.wide ? "wide " : ""}${f.need && (val === "" || val == null) ? "miss" : ""}" data-need="${f.need ? 1 : ""}"${f.home ? ` data-home="1"${isHome(v.account) ? "" : " hidden"}` : ""}>${f.label}${input}</label>`;
  }).join("") + '<span class="calc"></span>';
}

function bindFields(box) {
  const update = (e) => {
    // a home bill: the fields of what was paid and its percentage, and the expense worked out from them
    const home = isHome(box.querySelector("[name=account]").value);
    box.querySelectorAll("label[data-home='1']").forEach((l) => (l.hidden = !home));
    const pct = box.querySelector("[name=pct]");
    if (home && pct.value === "") pct.value = HOME_PCT;
    if (home && ["paid", "pct", "account"].includes(e?.target.name)) {
      const paid = parseFloat(box.querySelector("[name=paid]").value);
      if (!isNaN(paid)) box.querySelector("[name=amount]").value = round2(paid * (parseFloat(pct.value) || 0) / 100);
    }
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
    out[f.k] = f.type === "number" ? (v === "" ? null : f.exact ? parseFloat(v) : round2(parseFloat(v))) : v;
  }
  if (!isHome(out.account)) out.paid = out.pct = null;
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
  // Two documents someone compared and said are not the same.
  if ((a.notDup || []).includes(b.id) || (b.notDup || []).includes(a.id)) return "";
  if (a.fileHash && a.fileHash === b.fileHash) return "אותו קובץ בדיוק";
  if (a.docNo && a.docNo === b.docNo && sameSupplier(a, b)) return "אותו ספק ואותו מספר מסמך";
  if (a.amount && a.amount === b.amount && a.date && a.date === b.date && sameSupplier(a, b)) return "אותו ספק, תאריך וסכום";
  return "";
}
const describe = (x) => [x.client, x.supplier, showDate(x.date), x.amount ? fmt(x.amount) : "", x.fileName].filter(Boolean).join(" · ");

// Saved this session but maybe not yet back from the database, so a copy right behind it is still caught.
const savedNow = [];
function findDuplicate(r, exceptId, skip = []) {
  const seen = new Set(skip);
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

function reviewReasons(r, { exceptId, noText = false, failed = "", skip = [] } = {}) {
  const why = [];
  if (failed) why.push(`הקובץ לא נקרא (${failed})`);
  else if (noText) why.push("לא נמצא טקסט במסמך");
  const missing = FIELDS.filter((f) => f.need && !r[f.k]).map((f) => f.label.replace(/ \(.*\)/, ""));
  if (missing.length && !failed) why.push(`חסר: ${missing.join(", ")}`);
  // A document uploaded under a client is theirs even when made out to someone else (a spouse, say).
  if (!r.client) why.push(r.customer ? `הלקוח "${r.customer}" שבמסמך לא נמצא ברשימת הלקוחות` : "לא שויך ללקוח");
  const dup = findDuplicate(r, exceptId, skip);
  if (dup) why.push(`ייתכן כפילות (${dup.why}) של: ${dup.what}`);
  if (r.supplier && odd(r.supplier)) why.push("שם הספק נראה משובש");
  if (foreign(r) && !r.rate) why.push(`תשלום ב-${r.currency}: חסר שער יציג ליום התשלום`);
  // a date years back is most likely a misread year ("31/05/01" for 2025)
  if (r.date && +r.date.slice(0, 4) < new Date().getFullYear() - 6) why.push(`התאריך נראה שגוי (שנת ${r.date.slice(0, 4)})`);
  return why;
}

// ---------- reading with Claude ----------
// The picture goes to the readDocument function, with where the file was kept and the app's own lists.
// -> { fields, account, unclear } or null (local mode, or the service failed: the local reading stays).
// After a failure that will not pass by itself (no key, no function yet) it is not tried again.
let aiOff = !CLOUD || !AI_READING;
const AI_LABELS = { supplier: "ספק", supplierId: "ח.פ", customer: "שם הלקוח", date: "תאריך", amount: "סכום",
  vat: "מע״מ", docType: "סוג מסמך", docNo: "מספר מסמך", account: "חשבון" };
async function aiReading(image, path, onStatus) {
  if (aiOff || !store.aiRead || !/^data:image\//.test(image || "")) return null;
  onStatus?.("🤖 קורא עם Claude…");
  try {
    const r = await store.aiRead({ image, path, docTypes: DOC_TYPE_NAMES.filter((t) => t !== "אחר"),
      categories: CATEGORY_NAMES, accounts: EXPENSE_ACCOUNTS });
    const fields = {};
    for (const k of ["supplier", "supplierId", "customer", "docNo", "details"]) if (r[k]) fields[k] = String(r[k]).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(r.date || "") && r.date <= new Date().toISOString().slice(0, 10)) fields.date = r.date;
    for (const k of ["amount", "vat"]) if (typeof r[k] === "number" && r[k] > 0) fields[k] = r[k];
    if (r.docType) fields.docType = r.docType;
    if (r.currency) fields.currency = r.currency;
    if (r.category) fields.category = r.category;
    const unsure = (r.unclear || []).map((k) => AI_LABELS[k]).filter(Boolean);
    return { fields, account: r.account || "", unclear: unsure.length ? `Claude לא בטוח ב: ${unsure.join(", ")}` : "" };
  } catch (e) {
    if (/not-found|failed-precondition|permission-denied|unauthenticated/.test(e.code || "")) aiOff = true;
    console.warn("Claude reading failed:", e.code, e.message);
    return null;
  }
}

// A supplier's name that is not a name: a time or a date in it, a long number, a label from the
// receipt ("שעה:"), or more stray marks and single letters than words ("% ג ו יי אי אוא").
function odd(name) {
  if (/\d{1,2}:\d{2}|\d{1,2}[./]\d{1,2}[./]\d{2}|\d{5,}|(?:שעה|תאריך|קופה)\s*:/.test(name)) return true;
  const words = name.split(/\s+/).filter(Boolean);
  const real = words.filter((w) => w.replace(/[^\p{L}]/gu, "").length >= 2).length;
  return real === 0 || words.length - real > real || /[%=\\|~^]/.test(name);
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
  let keptTwin = false; // the person already said to keep it: not asked again about its content
  // The same file, its record still waiting for review: read again into that record, if the person says so.
  if (reread) {
    if (!(await askKeepDuplicate(el, show, "הקובץ הזה כבר קיים במערכת ומחכה לבדיקה", describe(reread), "📖 לקרוא מחדש ולעדכן"))) {
      progDone(item, "skipped");
      show("dup", `⏭️ <b>לא נקלט: הקובץ כבר קיים במערכת</b><br><small>${esc(describe(reread))}</small>`);
      return;
    }
    body.innerHTML = '<div class="status"><span class="label">ממתין…</span><div class="bar"><i></i></div></div>';
  }
  if (sameFile) {
    if (!(await askKeepDuplicate(el, show, "הקובץ הזה בדיוק כבר קיים במערכת", sameFile))) { progDone(item, "skipped"); show("dup", `⏭️ <b>לא נקלט: הקובץ כבר קיים במערכת</b><br><small>${esc(sameFile)}</small>`); return; }
    keptTwin = true;
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
  let found = failed ? {} : parseText(text, hint, alt);
  // Claude reads the picture; what it finds wins over the local reading, which stays when it fails.
  const ai = preview ? await aiReading(preview, path, (label) => status(0.95, label)) : null;
  if (ai) found = { ...found, ...ai.fields, category: found.donation ? "תרומות" : ai.fields.category ?? found.category };
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
  // Paid in a foreign currency: the amount as read is in that currency; the shekel amount comes from the
  // representative rate of the payment day.
  if (found.currency && !foreign(rec)) {
    Object.assign(rec, { currency: found.currency, origAmount: rec.amount, origVat: rec.vat, amount: null, vat: null, rate: null, rateDate: "" });
    status(0.97, "💱 שער יציג…");
    await convertCurrency(rec);
  }
  // The date, the journal account and the service type from the folders and the file's name, where
  // the document itself did not tell them (the account by the kind of item, from all its text).
  fillFromPath(rec, `${text}\n${alt}`);
  // Claude's account, from the items it saw, unless one was chosen by hand.
  if (ai?.account && rec.accountBy !== "hand") Object.assign(rec, { account: ai.account, accountBy: "auto" });
  const why = [...reviewReasons(rec, { exceptId: reread?.id, noText: !ai && !failed && !text.trim() && !alt.trim(), failed: ai ? "" : failed }),
    ...(ai?.unclear ? [ai.unclear] : [])];
  if (ai) failed = "";
  rec.status = failed ? "failed" : why.length ? "review" : "ok";
  rec.reviewWhy = why.join(" · ");

  // The same document already in the system by what it says (another scan or photo of it): saved only
  // when the person says so.
  const twin = !reread && !failed && !keptTwin && findDuplicate(rec);
  if (twin && !(await askKeepDuplicate(el, show, `נראה שהמסמך כבר קיים במערכת (${twin.why})`, twin.what))) {
    inFlight.delete(hash);
    progDone(item, "skipped");
    show("dup", `⏭️ <b>לא נשמר: המסמך כבר קיים במערכת</b><br><small>${esc(twin.what)}</small>`);
    return;
  }
  try {
    let id;
    if (reread) { id = reread.id; await store.update(id, rec); }
    else id = await store.add(rec, preview);
    savedNow.push({ ...rec, id });
    if (driveAuth) findInDrive(path).then((driveId) => driveId && store.update(id, { driveId })).catch(() => {});
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

// A file that is already in the system (the same file, or the same document by its content) waits for the
// person: keep it anyway, or leave it out. A note at the top counts the files still waiting.
let dupWaiting = 0;
function renderDupWait() {
  $("dupWait").hidden = !dupWaiting;
  $("dupWait").textContent = `⚠️ ${dupWaiting === 1 ? "קובץ אחד כבר קיים" : `${dupWaiting} קבצים כבר קיימים`} במערכת ו${dupWaiting === 1 ? "ממתין" : "ממתינים"} לאישור שלך: לשמור או לא (מסומנים בצהוב ברשימה).`;
}
async function askKeepDuplicate(el, show, title, what, keepLabel = "💾 לשמור בכל זאת") {
  dupWaiting++;
  renderDupWait();
  toast(`⚠️ ${title}. אשרו ברשימת הקליטה`);
  show("dup ask", `⚠️ <b>${esc(title)}</b><br><small>${esc(what)}</small>`,
    `<button class="primary keep-it">${keepLabel}</button><button class="ghost skip-it">✕ לא</button>`);
  const keep = await new Promise((done) => {
    el.querySelector(".keep-it").onclick = () => done(true);
    el.querySelector(".skip-it").onclick = () => done(false);
  });
  dupWaiting--;
  renderDupWait();
  return keep;
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

let reviewSeen = 0; // how many documents waited for review when the note was last answered
const answerReview = () => { reviewSeen = records.filter((r) => inScope(r) && needsReview(r)).length; $("reviewNote").classList.remove("blink"); };

function renderAll() {
  markDuplicates();
  if (records.length) fillMissingRates();
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
  // It blinks until it is answered (ticked, or a document opened from the list); more documents waiting
  // than when it was last answered make it blink again.
  $("reviewNote").classList.toggle("blink", review > reviewSeen && !$("reviewOnly").checked);
  $("reviewBadge").hidden = !review;
  $("reviewBadge").textContent = review;
  if (!review) $("reviewOnly").checked = false;
  renderTable();
  renderSummary();
  renderJournal();
  renderDonations();
  renderMisc();
}

// id -> why it looks like another saved record. Recomputed whenever the records change.
// dupWith: id -> the ids of the records it looks like.
let dupOf = new Map(), dupWith = new Map();
function markDuplicates() {
  dupOf = new Map();
  dupWith = new Map();
  const pair = (a, b) => dupWith.set(a, [...(dupWith.get(a) || []), b]);
  for (let i = 0; i < records.length; i++)
    for (let j = i + 1; j < records.length; j++) {
      const why = dupReason(records[i], records[j]);
      if (!why) continue;
      dupOf.set(records[i].id, `${why}, כמו: ${describe(records[j])}`);
      dupOf.set(records[j].id, `${why}, כמו: ${describe(records[i])}`);
      pair(records[i].id, records[j].id);
      pair(records[j].id, records[i].id);
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
    <td class="sel"><span class="sel-box"><input type="checkbox" data-sel="${r.id}"${selected.has(r.id) ? " checked" : ""} aria-label="בחירה">${tickBtn(r)}</span></td>
    <td class="num">${showDate(r.date)}</td>
    <td>${esc(r.client) || '<span class="soon">ללא</span>'}</td>
    <td title="${esc([r.supplier, r.details].filter(Boolean).join(" · "))}">${typeTag(r)}${statusTag(r)}${esc(r.supplier) || `<span class="soon">${esc(r.fileName)}</span>`}${r.details ? `<small>${esc(r.details)}</small>` : ""}</td>
    <td>${r.category ? `<span class="tag">${esc(r.category)}</span>` : ""}</td>
    <td>${esc(r.docType)}${r.docNo ? `<small>מס׳ ${esc(r.docNo)}</small>` : ""}</td>
    <td class="num">${r.vat ? fmt(r.vat) : ""}</td>
    <td class="num">${r.amount ? fmt(r.amount) : ""}${foreign(r) ? `<small title="${esc(fxNote(r))}">${FX[r.currency].sign}${fmt2(r.origAmount)}</small>` : ""}</td>
    <td class="row-del"><button type="button" class="icon-del" data-del="${r.id}" title="מחיקת המסמך" aria-label="מחיקת המסמך">🗑️</button></td></tr>`).join("");
  syncSelection();
  showSide(shownIds.includes(current) ? current : null);
  if (docView === "gallery") renderGallery(rows);
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
$("reviewNote").addEventListener("click", answerReview);
$("rows").addEventListener("click", (e) => {
  if (e.target.closest("tr")) answerReview();
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
  current = tr.dataset.id;
  openEntry(tr.dataset.id);
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
  // Two questions, each its own: what is deleted, and then that it is for good.
  // Only the app's record goes: the original file in Drive or on the computer is never touched.
  if (!(await askDeleteTwice(`למחוק מהתוכנה ${what}?`,
    `${ids.length === 1 ? "הרשומה והתמונה שלה יימחקו" : `${ids.length} הרשומות והתמונות שלהן יימחקו`} מהתוכנה לצמיתות, ואי אפשר יהיה לשחזר אותן. הקבצים המקוריים נשארים בדרייב.`))) return false;
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

// ---------- the documents as a gallery ----------
// The same documents (same filters and order) as cards with their pictures; a click opens the document.
// The pictures load as their cards come into view, so a long list stays quick.
let docView = (() => { try { return localStorage.getItem("fairy-doc-view") || "list"; } catch { return "list"; } })();
let galleryWatch = null;
function setDocView(v) {
  docView = v;
  try { localStorage.setItem("fairy-doc-view", v); } catch { /* the choice just is not kept */ }
  document.querySelectorAll("[data-docview]").forEach((b) => b.classList.toggle("on", b.dataset.docview === v));
  $("gallery").hidden = v !== "gallery";
  document.querySelector(".docs-split").hidden = v === "gallery";
  renderTable();
}
document.querySelectorAll("[data-docview]").forEach((b) => (b.onclick = () => setDocView(b.dataset.docview)));
// the view chosen last time
document.querySelectorAll("[data-docview]").forEach((b) => b.classList.toggle("on", b.dataset.docview === docView));
$("gallery").hidden = docView !== "gallery";
document.querySelector(".docs-split").hidden = docView === "gallery";
function renderGallery(rows) {
  galleryWatch?.disconnect();
  $("gallery").innerHTML = rows.map((r) => `<div class="g-card${needsReview(r) ? " dup" : ""}${r.checked ? " checked" : ""}" data-id="${esc(r.id)}" tabindex="0">
      <div class="g-pic" data-pic="${esc(r.id)}"><small class="soon">${/›/.test(r.fileName || "") ? "שורה מאקסל" : "טוען…"}</small></div>
      <div class="g-info">
        <b>${typeTag(r)}${statusTag(r)}${esc(r.supplier) || `<span class="soon">${esc(r.fileName)}</span>`}</b>
        <small>${esc([showDate(r.date), r.category].filter(Boolean).join(" · "))}</small>
        <span class="g-foot"><b>${r.amount ? fmt(r.amount) : ""}</b>${tickBtn(r)}</span>
      </div></div>`).join("") || '<p class="empty">אין מסמכים להצגה.</p>';
  galleryWatch = new IntersectionObserver((seen) => {
    for (const e of seen) {
      if (!e.isIntersecting) continue;
      galleryWatch.unobserve(e.target);
      const id = e.target.dataset.pic;
      previewOf(id).then((src) => {
        if (src) e.target.innerHTML = `<img src="${src}" alt="" loading="lazy">`;
        else if (!/›/.test(records.find((x) => x.id === id)?.fileName || "")) e.target.innerHTML = '<small class="soon">אין תמונה</small>';
      });
    }
  }, { rootMargin: "300px" });
  $("gallery").querySelectorAll("[data-pic]").forEach((el) => galleryWatch.observe(el));
}
$("gallery").addEventListener("click", (e) => {
  const card = e.target.closest(".g-card");
  if (card) { current = card.dataset.id; answerReview(); openEntry(card.dataset.id); }
});
$("gallery").addEventListener("keydown", (e) => {
  const card = e.target.closest(".g-card");
  if (card && e.key === "Enter") openEntry(card.dataset.id);
});

// ---------- the green tick: a document a person went over ----------
// Set by "שמירה ואישור", by applying a change to the documents ticked in the list, or by hand in the
// journal, the documents' list and the gallery (a click turns it on or off).
const tickBtn = (r) => `<button type="button" class="tick${r.checked ? " on" : ""}" data-tick="${esc(r.id)}"
  title="${r.checked ? "נבדק · לחיצה מבטלת" : "לא סומן כנבדק · לחיצה מסמנת"}" aria-pressed="${!!r.checked}">✓</button>`;
async function toggleTick(id) {
  const r = records.find((x) => x.id === id);
  if (!r) return;
  try { await store.update(id, { checked: !r.checked }); }
  catch (err) { toast("השמירה נכשלה: " + err.message); }
}
// one listener for every list with ticks
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-tick]");
  if (!b) return;
  e.stopPropagation();
  e.preventDefault();
  toggleTick(b.dataset.tick);
}, true);

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
      ${line("סכום", r.amount ? fmt(r.amount) : "")}${line("מטבע", foreign(r) ? esc(fxNote(r).replace(/^💱 /, "")) : "")}${line("מע״מ", r.vat ? fmt(r.vat) : "")}${line("סוג שירות", esc(r.category))}
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
// A document that looks like another one opens beside it, to decide which to keep.
async function openEntry(id, fallback, plain = false) {
  if (!plain && dupWith.has(id)) { openCompare(id); return; }
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
  $("dlgFx").hidden = !foreign(r);
  $("dlgFx").innerHTML = foreign(r) ? `${esc(fxNote(r))} · <a href="${BOI_PAGE}" target="_blank" rel="noopener">שערי בנק ישראל</a>` : "";
  $("dlgPreview").innerHTML = '<p class="soon">טוען תמונה…</p>';
  // It opens straight on the whole screen: the picture on one half, the details on the other.
  $("entryDlg").classList.add("full");
  picZoom = 1;
  const list = navList(), i = list.indexOf(id);
  $("dlgNav").hidden = i < 0;
  $("dlgPos").textContent = i < 0 ? "" : `${i + 1} מתוך ${list.length}`;
  $("dlgPrev").disabled = i <= 0;
  $("dlgNext").disabled = i < 0 || i >= list.length - 1;
  if (!$("entryDlg").open) $("entryDlg").showModal();
  if (foreign(r) && !r.rate) fillRate(id);
  const src = await previewOf(id);
  if (editing !== id) return;
  dialogPicture(id, src, r);
}

// A foreign-currency document without its rate: the representative rate of its date is looked up and put
// in the form with the shekel amount, to check and save; also again when the date or the currency changes.
async function fillRate(id) {
  const box = $("dlgFields"), f = readFields(box);
  if (!foreign(f) || f.origAmount == null || !f.date) return;
  $("dlgFx").hidden = false;
  $("dlgFx").textContent = `💱 שולף את השער היציג של ${f.currency} ליום ${showDate(f.date)} מבנק ישראל…`;
  const got = await boiRate(f.currency, f.date);
  if (editing !== id) return;
  if (!got) {
    const upTo = await ratesUpdated();
    $("dlgFx").innerHTML = `💱 שולם ${FX[f.currency].sign}${fmt2(f.origAmount)} (${f.currency}). אין שער יציג לתאריך הזה${upTo && f.date > upTo ? ` (השערים במערכת עד ${showDate(upTo)})` : ""}: הקלידו אותו בשדה "שער יציג" · <a href="${BOI_PAGE}" target="_blank" rel="noopener">שערי בנק ישראל</a>`;
    return;
  }
  const set = (k, v) => { const el = box.querySelector(`[name=${k}]`); if (el) el.value = v; };
  set("rate", got.rate);
  set("amount", round2(f.origAmount * got.rate));
  box.dispatchEvent(new Event("input"));
  const shown = { ...f, rate: got.rate, rateDate: got.day, amount: round2(f.origAmount * got.rate) };
  $("dlgFx").innerHTML = `${esc(fxNote(shown))} · השער מבנק ישראל, לחצו שמירה · <a href="${BOI_PAGE}" target="_blank" rel="noopener">שערי בנק ישראל</a>`;
}
$("dlgFields").addEventListener("change", (e) => {
  if (["date", "currency", "origAmount"].includes(e.target.name)) {
    const rate = $("dlgFields").querySelector("[name=rate]");
    if (rate) rate.value = "";
    fillRate(editing);
  }
});

// In the background, once per visit: every foreign-currency document still without a rate gets the
// representative rate of its date, its shekel amount, and is checked again.
let ratesTried = false;
async function fillMissingRates() {
  if (ratesTried) return;
  const list = records.filter((r) => foreign(r) && !r.rate && r.date && r.origAmount != null);
  if (!list.length) return;
  ratesTried = true;
  let n = 0;
  for (const r of list) {
    const rec = { ...r };
    if (!(await convertCurrency(rec))) continue;
    const upd = { rate: rec.rate, rateDate: rec.rateDate, amount: rec.amount, vat: rec.vat ?? null };
    if (r.status === "review") {
      const why = reviewReasons({ ...r, ...upd }, { exceptId: r.id });
      Object.assign(upd, { status: why.length ? "review" : "ok", reviewWhy: why.join(" · ") });
    }
    try { await store.update(r.id, upd); n++; } catch { /* stays for the next visit */ }
  }
  if (n) toast(`💱 נשלף שער יציג ל-${n} מסמכים במטבע זר`);
}

// The documents in the list on show (the documents' list or the journal), to move between them in the window.
function navList() {
  const view = document.querySelector(".view-panel.view-active")?.dataset.view;
  if (view === "docs") return shownIds;
  if (view === "journal") return [...document.querySelectorAll("#jRows tr[data-id]")].map((tr) => tr.dataset.id);
  return [];
}
const dlgStep = (d) => {
  const list = navList(), next = list[list.indexOf(editing) + d];
  if (!next) return;
  current = next;
  if (dupWith.has(next)) $("entryDlg").close();
  openEntry(next);
};
$("dlgPrev").onclick = () => dlgStep(-1);
$("dlgNext").onclick = () => dlgStep(1);

// The document's picture in the dialog, with turning it and reading it again.
function dialogPicture(id, src, r) {
  if (!src) {
    $("dlgPreview").innerHTML = `<p class="soon">אין תמונה של המסמך.<br><b class="ltr-path">${esc(r.fileName)}</b></p>
      <div class="pic-tools"><button type="button" class="ghost" id="dlgWhole">📄 הקובץ המלא מהדרייב</button></div>`;
    $("dlgWhole").onclick = () => showWholeFile(r);
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
      <button type="button" class="ghost" id="dlgWhole" title="הקובץ המלא, כל העמודים, מהקובץ שלו בדרייב">📄 כל הקובץ</button>
    </div>
    <small class="soon">${full ? "גלגלת עם Ctrl מגדילה ומקטינה, וגרירה מזיזה את התמונה."
      : "לחיצה על התמונה פורשת את החלון על כל המסך: התמונה בחצי אחד והפרטים בחצי השני."}</small>`;
  pictureZoom(full);
  $("dlgWhole").onclick = () => showWholeFile(r);
  $("dlgRotate").onclick = async () => {
    const turned = await turnPicture(id, src);
    if (turned && editing === id) dialogPicture(id, turned, r);
  };
  $("dlgReread").onclick = async () => {
    const btn = $("dlgReread");
    btn.disabled = true;
    try {
      // Claude first; the reading in the browser only when it is not there.
      const ai = await aiReading(src, r.fileName || "", (label) => (btn.textContent = label));
      const found = ai ? ai.fields : await rereadPreview(src, 0, (p) => (btn.textContent = `📖 קורא… ${Math.round(p * 100)}%`))
        .then((res) => parseText(res.text, "", res.alt));
      if (ai?.account) found.account = ai.account;
      // What the new reading found replaces what was read before; the client stays.
      let n = 0;
      for (const k of ["date", "supplier", "supplierId", "customer", "category", "docType", "docNo", "amount", "vat", "details", "account"]) {
        const input = $("dlgFields").querySelector(`[name=${k}]`);
        if (!input || found[k] === "" || found[k] == null) continue;
        input.value = found[k];
        n++;
      }
      $("dlgFields").dispatchEvent(new Event("input"));
      toast(n ? `${ai ? "Claude קרא" : "נקראו"} ${n} פרטים מהתמונה.${ai?.unclear ? ` ${ai.unclear}.` : ""} בדקו אותם ושמרו.`
        : "גם בכיוון הזה לא נקראו פרטים. נסו לסובב את התמונה.");
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
        // Claude's reading replaces what was read before (these documents were not checked yet); without
        // it, the browser's reading only fills what is missing.
        const ai = await aiReading(src, r.fileName || "");
        const res = ai ? { text: "", alt: "" } : await rereadPreview(src, null);
        const found = ai ? ai.fields : parseText(res.text, "", res.alt);
        const upd = { ...r };
        for (const k of KEYS) if (!empty(found[k]) && (ai || empty(upd[k]))) upd[k] = found[k];
        if (!upd.text && !ai) upd.text = [res.text, res.alt].filter(Boolean).join("\n----\n").slice(0, 15000);
        fillFromPath(upd, `${res.text}\n${res.alt}`);
        if (ai?.account && upd.accountBy !== "hand") Object.assign(upd, { account: ai.account, accountBy: "auto" });
        const why = [...reviewReasons(upd, { exceptId: r.id }), ...(ai?.unclear ? [ai.unclear] : [])];
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
  if (foreign(rec)) {
    // A rate typed by hand is kept (for the document's date); otherwise a new date or currency takes the
    // representative rate of that day.
    rec.origVat = before?.origVat ?? null;
    const typed = rec.rate != null && rec.rate !== before?.rate;
    if (typed) rec.rateDate = rec.date;
    else {
      const moved = !before || before.date !== rec.date || before.currency !== rec.currency;
      rec.rateDate = moved ? "" : before.rateDate || "";
      if (moved) rec.rate = null;
    }
    await convertCurrency(rec);
  } else await convertCurrency(rec);
  const why = approve ? [] : reviewReasons(rec, { exceptId: editing });
  rec.status = why.length ? "review" : "ok";
  // "שמירה ואישור" ticks it as checked; a plain save keeps the tick it had
  rec.checked = approve || !!before?.checked;
  rec.reviewWhy = why.join(" · ");
  try {
    const id = editing;
    await store.update(id, rec);
    $("entryDlg").close();
    const spread = await spreadCategory(rec, id);
    toast((why.length ? "נשמר. המסמך עדיין מסומן לבדיקה" : "נשמר ואושר")
      + (spread ? `. סוג השירות "${rec.category}" נוסף גם ל-${spread} מסמכים של אותו ספק` : ""));
    if (before && rec.supplier && rec.supplier !== before.supplier) await offerSupplierFix(before.supplier || "", rec, id);
    if (before) await offerSameSupplier(before, rec, id);
  } catch (err) { toast("השמירה נכשלה: " + err.message); }
}

// ---------- a supplier's name corrected by hand, on its look-alikes ----------
// Pairs of letters two names share (0 to 1): a misread name ("שחל המרתהטעצרעים") still shares many
// of them with the right one ("שחק אותה צעצועים"); an unrelated supplier hardly any.
function nameLikeness(a, b) {
  const norm = (s) => (s || "").toLowerCase().replace(/בע["״']?מ/g, "").replace(/[^\p{L}]/gu, "");
  const grams = (s) => { const g = new Map(); for (let i = 0; i < s.length - 1; i++) g.set(s.slice(i, i + 2), (g.get(s.slice(i, i + 2)) || 0) + 1); return g; };
  a = norm(a); b = norm(b);
  if (a.length < 2 || b.length < 2) return a && a === b ? 1 : 0;
  const A = grams(a), B = grams(b);
  let both = 0;
  for (const [k, n] of A) both += Math.min(n, B.get(k) || 0);
  return (2 * both) / (a.length + b.length - 2);
}

// The list of documents to tick, each with its picture (a click on it enlarges it). -> the ticked ids, or
// [] when the person says no.
async function pickDocs(title, hint, docs) {
  $("supTitle").textContent = title;
  $("supHint").innerHTML = hint;
  $("supList").innerHTML = docs.map((x) => `<label class="sup-row"><input type="checkbox" value="${esc(x.id)}" checked>
    <span class="sup-thumb" data-pic="${esc(x.id)}"><small class="soon">טוען…</small></span>
    <span class="sup-text"><b>${esc(x.supplier)}</b><small>${esc([x.client, showDate(x.date), x.amount ? fmt(x.amount) : "", x.docType, x.category].filter(Boolean).join(" · "))}</small></span></label>`).join("");
  $("supDlg").showModal();
  for (const x of docs) {
    previewOf(x.id).then((src) => {
      const box = $("supList").querySelector(`[data-pic="${CSS.escape(x.id)}"]`);
      if (!box) return;
      box.innerHTML = src ? `<img src="${src}" alt="" title="לחיצה מגדילה">` : '<small class="soon">אין תמונה</small>';
      const img = box.querySelector("img");
      if (img) img.onclick = (e) => { e.preventDefault(); zoom(src); };
    });
  }
  const ok = await new Promise((done) => {
    $("supYes").onclick = () => done(true);
    $("supNo").onclick = () => done(false);
    $("supDlg").oncancel = () => done(false);
  });
  const ids = [...$("supList").querySelectorAll("input:checked")].map((i) => i.value);
  $("supDlg").close();
  return ok ? ids : [];
}

// Saves the same change on each ticked document; one waiting for review is checked again.
async function applyToDocs(ids, change) {
  let n = 0;
  for (const xid of ids) {
    const x = records.find((r) => r.id === xid);
    if (!x) continue;
    const upd = { ...change(x), checked: true };
    if (x.status === "review") {
      const why = reviewReasons({ ...x, ...upd }, { exceptId: x.id, noText: (x.reviewWhy || "").includes("לא נמצא טקסט") });
      Object.assign(upd, { status: why.length ? "review" : "ok", reviewWhy: why.join(" · ") });
    }
    try { await store.update(xid, upd); n++; } catch { /* the rest still go on */ }
  }
  return n;
}

// After a supplier's name is corrected, the documents whose supplier looks like it (or like the name it
// had before, or has the same company number) are offered to take the corrected name, ticked in a list.
async function offerSupplierFix(oldName, rec, id) {
  const like = records.map((x) => ({ x, score: Math.max(nameLikeness(x.supplier, rec.supplier), nameLikeness(x.supplier, oldName),
      rec.supplierId && x.supplierId === rec.supplierId ? 1 : 0) }))
    .filter(({ x, score }) => x.id !== id && x.supplier && x.supplier !== rec.supplier && score >= 0.3)
    .sort((a, b) => b.score - a.score).slice(0, 40).map(({ x }) => x);
  if (!like.length) return;
  const ids = await pickDocs(`לעדכן את שם הספק ל"${rec.supplier}" גם במסמכים הדומים?`,
    "סמנו את המסמכים של אותו ספק. מסמך שאינו שלו, בטלו את הסימון שלו.", like);
  if (!ids.length) return;
  const n = await applyToDocs(ids, (x) => ({
    supplier: rec.supplier,
    ...(!x.supplierId && rec.supplierId ? { supplierId: rec.supplierId } : {}),
    ...(!x.category && rec.category ? { category: rec.category } : {}),
  }));
  toast(`שם הספק עודכן ב-${n} מסמכים`);
}

// After the service type, the journal account, the company number or the document type of one document
// is changed, the supplier's other documents that differ are offered the same, ticked in a list.
const SUPPLIER_FIELDS = [["category", "סוג שירות"], ["account", "חשבון חובה"], ["supplierId", "ח.פ / ע.מ"], ["docType", "סוג מסמך"]];
async function offerSameSupplier(before, rec, id) {
  const valueOf = (x, k) => (k === "account" ? accountOf(x) : x[k] || "");
  const changed = SUPPLIER_FIELDS.filter(([k]) => rec[k] && rec[k] !== valueOf(before, k));
  if (!changed.length || !rec.supplier) return;
  const others = records.filter((x) => x.id !== id && sameSupplier(rec, x) && changed.some(([k]) => valueOf(x, k) !== rec[k])).slice(0, 60);
  if (!others.length) return;
  const show = (k, v) => (k === "account" ? `${v} · ${accountName(v)}` : v);
  const what = changed.map(([k, label]) => `${label}: <b>${esc(show(k, rec[k]))}</b>`).join(" · ");
  const ids = await pickDocs(`לשנות גם ב-${others.length} מסמכים נוספים של "${rec.supplier}"?`,
    `${what}<br>מסמך שלא צריך את השינוי, בטלו את הסימון שלו.`, others);
  if (!ids.length) return;
  const n = await applyToDocs(ids, () => Object.fromEntries(changed.flatMap(([k]) =>
    k === "account" ? [["account", rec.account], ["accountBy", "hand"]] : [[k, rec[k]]])));
  toast(`עודכנו ${n} מסמכים של ${rec.supplier}`);
}
$("entryForm").onsubmit = (e) => { e.preventDefault(); saveEntry(false); };
$("approveBtn").onclick = () => saveEntry(true);
$("cancelBtn").onclick = () => $("entryDlg").close();
$("delBtn").onclick = async () => { if (await deleteDocs([editing])) $("entryDlg").close(); };

// ---------- two documents that look the same, side by side ----------
// The whole screen: one document on each side and their details between them, the differences marked.
// From here one of them is deleted, or opened for editing, or shown in the list, or both are kept.

let comparing = null; // [id on the right, id on the left]
const uploadedAt = (r) => {
  const t = r.createdAt?.toDate ? r.createdAt.toDate() : r.createdAt ? new Date(r.createdAt) : null;
  return t && !isNaN(t) ? t.toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" }) : "";
};

function openCompare(id, otherId) {
  const others = dupWith.get(id) || [];
  if (!others.length) { openEntry(id, null, true); return; }
  const other = others.includes(otherId) ? otherId : others[0];
  comparing = [id, other];
  $("dupOther").hidden = others.length < 2;
  $("dupOther").innerHTML = others.map((o, i) => {
    const x = records.find((r) => r.id === o) || {};
    return `<option value="${esc(o)}"${o === other ? " selected" : ""}>מול מסמך ${i + 1}: ${esc(describe(x))}</option>`;
  }).join("");
  const a = records.find((r) => r.id === id), b = records.find((r) => r.id === other);
  $("dupWhy").textContent = `⚠️ ${dupReason(a, b) || "ייתכן כפילות"}. השוו את שני המסמכים והחליטו איזה מהם להשאיר.`;
  $("dupData").innerHTML = compareTable(a, b);
  compareSide($("dupA"), a, "המסמך הזה");
  compareSide($("dupB"), b, "המסמך הדומה");
  if (!$("dupDlg").open) $("dupDlg").showModal();
}

function compareTable(a, b) {
  const rows = [
    ["לקוח", (r) => r.client], ["שם במסמך", (r) => r.customer], ["תאריך", (r) => showDate(r.date)],
    ["ספק", (r) => r.supplier], ["ח.פ / ע.מ", (r) => r.supplierId], ["סוג שירות", (r) => r.category],
    ["סוג מסמך", (r) => r.docType], ["מספר מסמך", (r) => r.docNo], ["סכום", (r) => (r.amount ? fmt(r.amount) : "")],
    ["מע״מ", (r) => (r.vat ? fmt(r.vat) : "")], ["חשבון חובה", (r) => { const c = accountOf(r); return c ? `${c} · ${accountName(c)}` : ""; }],
    ["פירוט", (r) => r.details], ["מצב", (r) => (r.status === "ok" ? "✅ אושר" : r.status === "failed" ? "❌ לא נקרא" : "⚠️ לבדיקה")],
    ["הועלה", uploadedAt], ["קובץ", (r) => (r.fileName || "").split("/").pop()],
  ];
  return `<table class="dup-table"><thead><tr><th></th><th>המסמך הזה</th><th>המסמך הדומה</th></tr></thead><tbody>${rows.map(([label, get]) => {
    const x = String(get(a) ?? ""), y = String(get(b) ?? "");
    return `<tr class="${x === y ? "same" : "diff"}"><th>${label}</th><td>${esc(x) || "—"}</td><td>${esc(y) || "—"}</td></tr>`;
  }).join("")}</tbody></table>
  <p class="soon">שורה מודגשת: הפרטים שונים בין שני המסמכים.</p>`;
}

async function compareSide(box, r, title) {
  box.dataset.id = r.id;
  box.innerHTML = `<div class="dup-doc-head"><b>${title}</b>
      <span class="pic-zoom"><button type="button" class="ghost" data-zoom="out" title="הקטנה">−</button><button type="button" class="ghost" data-zoom="in" title="הגדלה">+</button><button type="button" class="ghost" data-zoom="fit" title="התאמה">↔</button></span></div>
    <div class="pic-frame"><p class="soon">טוען את המסמך…</p></div>
    <div class="dup-path"><span class="soon">מיקום:</span> <span class="ltr-path">${esc(r.fileName) || "—"}</span></div>
    <div class="dup-acts">
      <button type="button" class="ghost" data-act="copy" title="העתקת מיקום הקובץ המקורי, להדבקה בסייר הקבצים">📋 העתקת המיקום</button>
      <button type="button" class="ghost" data-act="list" title="סגירת החלון ומעבר למסמך ברשימת המסמכים">📍 הצגה ברשימה</button>
      <button type="button" class="ghost" data-act="edit">✏️ עריכה</button>
      <button type="button" class="danger" data-act="del">🗑️ מחיקת המסמך הזה</button>
    </div>`;
  const src = await previewOf(r.id);
  if (box.dataset.id !== r.id) return;
  const frame = box.querySelector(".pic-frame");
  frame.innerHTML = src ? `<img src="${src}" alt="" draggable="false">`
    : `<p class="soon">אין תמונה של המסמך${/›/.test(r.fileName) ? " (שורה מקובץ אקסל)" : ""}.</p>`;
  const img = frame.querySelector("img");
  if (!img) return;
  let k = 1;
  const apply = () => { img.style.width = `${k * 100}%`; };
  box.querySelector(".pic-zoom").onclick = (e) => {
    const what = e.target.closest("[data-zoom]")?.dataset.zoom;
    if (what === "in") k = Math.min(6, k * 1.25);
    else if (what === "out") k = Math.max(0.3, k * 0.8);
    else if (what === "fit") { k = 1; frame.scrollTo(0, 0); }
    apply();
  };
  frame.onwheel = (e) => { if (!e.ctrlKey) return; e.preventDefault(); k = Math.min(6, Math.max(0.3, k * (e.deltaY < 0 ? 1.15 : 0.87))); apply(); };
  frame.onpointerdown = (e) => {
    const sx = e.clientX, sy = e.clientY, left = frame.scrollLeft, top = frame.scrollTop;
    frame.setPointerCapture(e.pointerId);
    frame.onpointermove = (m) => { frame.scrollLeft = left - (m.clientX - sx); frame.scrollTop = top - (m.clientY - sy); };
    frame.onpointerup = () => { frame.onpointermove = null; };
  };
}

// The other document is checked again once this one is gone or was said to be different: a document
// waiting for review only because of the duplicate stops waiting.
async function recheckAfterDup(r, skip = [], extra = {}) {
  const upd = { ...r, ...extra };
  const changes = { ...extra };
  if (r.status === "review") {
    const why = reviewReasons(upd, { exceptId: r.id, skip, noText: (r.reviewWhy || "").includes("לא נמצא טקסט") });
    changes.status = why.length ? "review" : "ok";
    changes.reviewWhy = why.join(" · ");
  }
  if (Object.keys(changes).length) await store.update(r.id, changes);
}

$("dupDlg").addEventListener("click", async (e) => {
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (!act || !comparing) return;
  const id = e.target.closest("[data-id]").dataset.id;
  const r = records.find((x) => x.id === id);
  const otherId = comparing.find((x) => x !== id);
  if (!r) return;
  if (act === "copy") {
    try { await navigator.clipboard.writeText(r.fileName || ""); toast("המיקום הועתק. הדביקו אותו בחיפוש של סייר הקבצים."); }
    catch { prompt("מיקום הקובץ:", r.fileName || ""); }
  } else if (act === "list") {
    $("dupDlg").close();
    showView("docs");
    $("search").value = "";
    $("reviewOnly").checked = false;
    for (const f of ["catFilter", "typeFilter", "monthFilter"]) $(f).value = "";
    renderTable();
    if (shownIds.includes(id)) showSide(id);
    else toast("המסמך לא מוצג ברשימה (ייתכן שהוא של לקוח אחר)");
  } else if (act === "edit") {
    $("dupDlg").close();
    openEntry(id, null, true);
  } else if (act === "del") {
    if (!(await deleteDocs([id]))) return;
    const other = records.find((x) => x.id === otherId);
    if (other) { try { await recheckAfterDup(other, [id]); } catch { /* it stays marked; the list still shows it */ } }
    $("dupDlg").close();
  }
});
$("dupOther").oninput = () => comparing && openCompare(comparing[0], $("dupOther").value);
$("dupClose").onclick = () => $("dupDlg").close();
$("dupDlg").addEventListener("close", () => { comparing = null; });
$("dupKeepBoth").onclick = async () => {
  if (!comparing) return;
  const [a, b] = comparing.map((id) => records.find((x) => x.id === id));
  if (!a || !b) return;
  try {
    await recheckAfterDup(a, [], { notDup: [...new Set([...(a.notDup || []), b.id])] });
    await recheckAfterDup(b, [], { notDup: [...new Set([...(b.notDup || []), a.id])] });
    $("dupDlg").close();
    toast("סומן: שני מסמכים שונים. שניהם נשארים.");
  } catch (err) { toast("השמירה נכשלה: " + err.message); }
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

// ---------- journal entries (פקודות יומן) ----------
// Each document as one line, in the layout of the bookkeeping software's import (as in the tax-report
// workbook): four dates, supplier / details (24 characters at most), debit, credit, amount, reference,
// and the debit account's name. Every document is an expense: it debits its account and credits the
// owner's account (107000). The clients are exempt dealers, so the amount is the full amount paid.

// "2024-01-06" -> "06/01/24": day, month and year apart by slashes.
const jDate = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(2, 4)}` : "");
// The balance date (the fourth): a document from before the year counts from its first day.
const balanceDate = (iso, year) => (iso && year && iso < `${year}-01-01` ? `${year}-01-01` : iso);

// The year's lines, before the filters. For a licensed dealer (עוסק מורשה) a document with VAT is two
// lines: the expense without the VAT, and the VAT on the input-VAT account (מע"מ תשומות, 205002).
const VAT_ACCOUNT = "205002";
function yearLines() {
  const year = $("jYear").value;
  return records.filter((r) => inScope(r) && !isDonationDoc(r) && (!year || (r.date || "").startsWith(year)))
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""))
    .flatMap((r) => {
      const line = {
        r, date: r.date || "", balance: balanceDate(r.date || "", year),
        details: (r.supplier || r.details || r.fileName || "").replace(/\s+/g, " ").trim().slice(0, 24),
        debit: accountOf(r), credit: OWNER_ACCOUNT, amount: r.amount || 0, ref: r.docNo || "",
      };
      const vat = r.vat || 0;
      if (dealerOf(r.client, r.date) !== "licensed" || !vat || vat >= line.amount) return [line];
      return [{ ...line, amount: round2(line.amount - vat) }, { ...line, debit: VAT_ACCOUNT, amount: vat, vatLine: true }];
    });
}

const J_FILTERS = ["jSearch", "jMonth", "jAcc", "jStatus", "jMin", "jMax"];
// A click on a heading sorts by its column; again, the other way round.
let jSort = { key: "date", dir: 1 };
const J_SORT = {
  date: (l) => l.date, details: (l) => l.details, debit: (l) => +l.debit, credit: (l) => +l.credit,
  amount: (l) => l.amount, ref: (l) => (/^\d+$/.test(l.ref) ? +l.ref : l.ref), accName: (l) => accountName(l.debit),
  checked: (l) => (l.r.checked ? 1 : 0),
};
function sortLines(lines) {
  const get = J_SORT[jSort.key];
  return [...lines].sort((a, b) => {
    const x = get(a), y = get(b);
    const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "he", { numeric: true });
    return c * jSort.dir;
  });
}
$("jHead").addEventListener("click", (e) => {
  const th = e.target.closest("[data-jsort]");
  if (!th) return;
  const key = th.dataset.jsort;
  // amounts start from the largest, the rest from the start
  jSort = jSort.key === key ? { key, dir: -jSort.dir } : { key, dir: key === "amount" ? -1 : 1 };
  renderJournal();
});
const J_MONTHS = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];

// The lines shown: the year's lines through the search, month, account, state and amount filters.
function journalLines(base = yearLines()) {
  const q = $("jSearch").value.trim().toLowerCase(), month = $("jMonth").value, acc = $("jAcc").value, status = $("jStatus").value;
  const min = $("jMin").value === "" ? null : +$("jMin").value, max = $("jMax").value === "" ? null : +$("jMax").value;
  const shown = base.filter((l) => {
    if (month && l.date.slice(5, 7) !== month) return false;
    if (acc && l.debit !== acc) return false;
    if (status === "review" && !needsReview(l.r)) return false;
    if (status === "ok" && needsReview(l.r)) return false;
    if (status === "hand" && !byHand(l.r)) return false;
    if (status === "guessed" && byHand(l.r)) return false;
    if (status === "checked" && !l.r.checked) return false;
    if (status === "unchecked" && l.r.checked) return false;
    if (min != null && l.amount < min) return false;
    if (max != null && l.amount > max) return false;
    if (q) {
      const hay = [l.r.supplier, l.r.details, l.r.fileName, l.ref, l.debit, accountName(l.debit), String(l.amount), jDate(l.date)].join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  return sortLines(shown);
}

// Keeps a list's choice when it is still there after the options change.
function fillPairs(id, options) {
  const sel = $(id), cur = sel.value;
  sel.innerHTML = options.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join("");
  sel.value = options.some(([v]) => v === cur) ? cur : "";
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
  const base = yearLines();
  const months = [...new Set(base.map((l) => l.date.slice(5, 7)).filter(Boolean))].sort();
  fillPairs("jMonth", [["", "כל החודשים"], ...months.map((m) => [m, J_MONTHS[+m - 1] || m])]);
  const accs = [...new Set(base.map((l) => l.debit).filter(Boolean))].sort();
  fillPairs("jAcc", [["", "כל החשבונות"], ...accs.map((a) => [a, `${a} · ${accountName(a)}`])]);
  const lines = journalLines(base);
  const filtered = J_FILTERS.some((id) => $(id).value !== "");
  $("jClear").hidden = !filtered;
  const sum = lines.reduce((s, l) => s + l.amount, 0);
  $("jShown").textContent = filtered ? `מוצגות ${lines.length} מתוך ${base.length} שורות` : `${lines.length} שורות`;
  $("jSum").textContent = sum.toLocaleString("he-IL", { maximumFractionDigits: 2 });
  // the VAT line of a licensed dealer's document has its fixed account, not one to pick
  const acc = (l, inner, cls) => (l.vatLine ? inner : pickable(l, inner, cls));
  $("jRows").innerHTML = lines.map((l) => `<tr data-id="${esc(l.r.id)}" class="${needsReview(l.r) ? "dup" : ""}${l.vatLine ? " vat-line" : ""}">
      <td class="tick-cell">${l.vatLine ? "" : tickBtn(l.r)}</td>
      <td class="num">${jDate(l.date)}</td><td class="num">${jDate(l.date)}</td><td class="num">${jDate(l.date)}</td><td class="num">${jDate(l.balance)}</td>
      <td>${needsReview(l.r) && !l.vatLine ? '<span title="מסמך לבדיקה">⚠️</span> ' : ""}${foreign(l.r) ? `<span class="tag fx" title="${esc(fxNote(l.r))}">${FX[l.r.currency].sign} ${esc(l.r.currency)}</span> ` : ""}${esc(l.details)}</td>
      <td class="num">${acc(l, esc(l.debit), "acc-code")}</td>
      <td class="num">${l.credit}</td>
      <td class="num">${l.amount.toLocaleString("he-IL", { maximumFractionDigits: 2 })}</td>
      <td class="num">${esc(l.ref)}</td>
      <td>${acc(l, esc(accountName(l.debit)), "acc-name")}</td></tr>`).join("");
  $("jEmpty").hidden = lines.length > 0;
  document.querySelectorAll("#jHead [data-jsort]").forEach((th) => {
    th.querySelector(".arrow")?.remove();
    if (th.dataset.jsort === jSort.key) th.insertAdjacentHTML("beforeend", `<span class="arrow">${jSort.dir > 0 ? "▲" : "▼"}</span>`);
  });
  // The client's dealer type, beside the year.
  const one = client && client !== ALL;
  $("jDealer").hidden = !one;
  if (one) $("jDealerName").textContent = DEALER_NAMES[dealerOf(client)];
  $("jDealerChange").hidden = !OWNER_EMAILS.includes(user?.email) && CLOUD;
}
// Another year starts from the full list: the filters are cleared.
$("jYear").addEventListener("input", () => { J_FILTERS.forEach((id) => { $(id).value = ""; }); renderJournal(); });
J_FILTERS.forEach((id) => $(id).addEventListener("input", renderJournal));
$("jClear").onclick = () => { J_FILTERS.forEach((id) => { $(id).value = ""; }); renderJournal(); };
// Changing the type: only the owners, from a date, and on record.
$("jDealerChange").onclick = () => {
  if (!client || client === ALL) return;
  const now = dealerOf(client), to = now === "licensed" ? "exempt" : "licensed";
  $("dealerClient").textContent = client;
  $("dealerNow").textContent = DEALER_NAMES[now];
  $("dealerTo").textContent = DEALER_NAMES[to];
  $("dealerFrom").value = new Date().toISOString().slice(0, 10);
  $("dealerLog").innerHTML = dealerLog(client).map((e) => `<li><b>${DEALER_NAMES[e.dealer] || esc(e.dealer)}</b> ${e.from ? `מ-${showDate(e.from)}` : "מההתחלה"}${e.at ? ` · נקבע ${new Date(e.at).toLocaleDateString("he-IL")}` : ""}${e.by ? ` · ${esc(e.by)}` : ""}</li>`).join("");
  $("dealerSave").onclick = async () => {
    const from = $("dealerFrom").value;
    if (!from) { toast("בחרו מאיזה תאריך השינוי חל"); return; }
    if (!confirm(`לשנות את ${client} ל${DEALER_NAMES[to]} החל מ-${showDate(from)}?`)) return;
    try {
      await store.setDealer(client, to, from, dealerLog(client));
      $("dealerDlg").close();
      toast(`${client}: ${DEALER_NAMES[to]} החל מ-${showDate(from)}. השינוי נשמר בהיסטוריה`);
    } catch (err) { toast("השמירה נכשלה: " + err.message); }
  };
  $("dealerDlg").showModal();
};

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

// The same lines as an Excel sheet, laid out like the workbook: real dates shown as dd/mm/yy (always with slashes),
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
      // a quoted "/" is a slash as written; a bare one is the computer's own date separator (a "-" on some)
      if (cell && cell.t === "n") cell.z = 'dd"/"mm"/"yy';
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

// ---------- donations (תרומות) ----------
// Receipts for donations are not expenses: they are listed here, apart, and left out of the journal and
// the filing report. A document is a donation by its service type "תרומות" (set when the reading finds
// "קבלה על תרומה", "סעיף 46" and the like, or chosen by hand).
const isDonationDoc = (r) => r.category === "תרומות";
// The receipt says the institution is approved for the tax credit of section 46.
const section46 = (r) => /סעיף\s*46|לעניין\s*סעיף|מוכר\s*לצורכי\s*זיכוי|זיכוי\s*ממס/.test(r.text || "");

function donationLines() {
  const year = $("dYear").value;
  return records.filter((r) => inScope(r) && isDonationDoc(r) && (!year || (r.date || "").startsWith(year)))
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
}
function renderDonations() {
  const all = records.filter((r) => inScope(r) && isDonationDoc(r));
  const years = [...new Set(all.map((r) => (r.date || "").slice(0, 4)).filter(Boolean))].sort().reverse();
  const cur = $("dYear").value;
  $("dYear").innerHTML = '<option value="">כל השנים</option>' + years.map((y) => `<option>${esc(y)}</option>`).join("");
  $("dYear").value = years.includes(cur) ? cur : (years[0] || "");
  const rows = donationLines();
  $("dRows").innerHTML = rows.map((r) => `<tr data-id="${esc(r.id)}" class="${needsReview(r) ? "dup" : ""}">
      <td class="num">${showDate(r.date)}</td>
      <td>${needsReview(r) ? '<span title="מסמך לבדיקה">⚠️</span> ' : ""}${esc(r.supplier) || `<span class="soon">${esc(r.fileName)}</span>`}</td>
      <td class="num">${esc(r.supplierId)}</td><td class="num">${esc(r.docNo)}</td>
      <td>${section46(r) ? '<span class="tag">✓ סעיף 46</span>' : ""}</td>
      <td class="num">${r.amount ? fmt(r.amount) : ""}</td></tr>`).join("");
  $("dCount").textContent = rows.length;
  $("d46").textContent = rows.filter(section46).length;
  $("dSum").textContent = fmt(round2(rows.reduce((t, r) => t + (r.amount || 0), 0)));
  $("dEmpty").hidden = rows.length > 0;
}
$("dYear").addEventListener("input", renderDonations);
$("dRows").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-id]"); if (tr) openEntry(tr.dataset.id); });
$("dExport").onclick = () => {
  const rows = donationLines();
  if (!rows.length) { toast("אין מה לייצא"); return; }
  const toDate = (iso) => (iso ? (Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) - Date.UTC(1899, 11, 30)) / 864e5 : "");
  const aoa = [["תאריך", "עמותה / מוסד", "ח.פ / ע.ר", "מספר קבלה", "סעיף 46", "סכום"],
    ...rows.map((r) => [toDate(r.date), r.supplier || "", r.supplierId || "", r.docNo || "", section46(r) ? "כן" : "", r.amount || 0])];
  aoa.push(["", "סה״כ", "", "", "", round2(rows.reduce((t, r) => t + (r.amount || 0), 0))]);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  for (let i = 1; i < aoa.length; i++) {
    const d = ws[XLSX.utils.encode_cell({ r: i, c: 0 })];
    if (d && d.t === "n") d.z = 'dd"/"mm"/"yy';
    const n = ws[XLSX.utils.encode_cell({ r: i, c: 5 })];
    if (n && n.t === "n") n.z = "#,##0.00";
  }
  ws["!cols"] = [10, 30, 12, 12, 9, 12].map((wch) => ({ wch }));
  const wb = XLSX.utils.book_new();
  wb.Workbook = { Views: [{ RTL: true }] };
  XLSX.utils.book_append_sheet(wb, ws, "תרומות");
  const who = client && client !== ALL ? `${client} ` : "";
  XLSX.writeFile(wb, `תרומות ${who}${$("dYear").value || "כל השנים"}.xlsx`);
};

// ---------- deletion questions ----------
// A deletion asks twice, each time in its own place on the screen, large and red, with the buttons the
// other way round the second time: two clicks in the same spot never delete anything.
const ASK_SPOTS = ["spot-top-right", "spot-bottom-left", "spot-top-left", "spot-bottom-right", "spot-middle"];
let lastSpot = "";
function askDelete(title, text, { second = false, okLabel = "🗑️ למחוק" } = {}) {
  return new Promise((done) => {
    const spot = (() => { const free = ASK_SPOTS.filter((s) => s !== lastSpot); return free[Math.floor(Math.random() * free.length)]; })();
    lastSpot = spot;
    const dlg = $("askDlg");
    dlg.className = `ask-dlg ${spot}${second ? " second" : ""}`;
    $("askTitle").textContent = title;
    $("askText").textContent = text;
    const yes = `<button type="button" class="danger ask-yes">${esc(okLabel)}</button>`;
    const no = '<button type="button" class="ghost ask-no">ביטול</button>';
    $("askBtns").innerHTML = second ? yes + no : no + yes;
    const finish = (v) => { dlg.close(); done(v); };
    $("askBtns").querySelector(".ask-yes").onclick = () => finish(true);
    $("askBtns").querySelector(".ask-no").onclick = () => finish(false);
    dlg.oncancel = (e) => { e.preventDefault(); finish(false); };
    dlg.showModal();
    $("askBtns").querySelector(".ask-no").focus();
  });
}
// The two questions of a deletion; -> true only when both are answered "delete".
async function askDeleteTwice(what, finalText) {
  if (!(await askDelete("מחיקה מהתוכנה", `${what}\nהקובץ המקורי בדרייב ובמחשב לא יימחק.`))) return false;
  return askDelete("אישור שני ואחרון", finalText, { second: true, okLabel: "🗑️ כן, למחוק לצמיתות" });
}

// ---------- the original files, in Google Drive ----------
// The files stay in the client's Google Drive; each document is linked to its file there (driveId), found
// by its name and the folders it was uploaded from. The app only asks to see the names and places of the
// files (drive.metadata.readonly), never their content: the whole file is shown by Drive's own viewer,
// with the signed-in person's own access to it.
let driveAuth = null; // { token, until }: Google gives it for an hour
async function driveToken(ask = true) {
  if (driveAuth && driveAuth.until > Date.now()) return driveAuth.token;
  if (!ask || !store.driveToken) return "";
  const token = await store.driveToken();
  if (token) driveAuth = { token, until: Date.now() + 50 * 60e3 };
  return token || "";
}
async function driveGet(path, params) {
  const token = await driveToken(false);
  if (!token) throw new Error("אין חיבור לדרייב");
  const res = await fetch(`https://www.googleapis.com/drive/v3/${path}?${new URLSearchParams(params)}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) { driveAuth = null; throw new Error("החיבור לדרייב פג, התחברו שוב"); }
  if (!res.ok) throw new Error(`הדרייב ענה ${res.status}`);
  return res.json();
}
const driveFolders = new Map(); // folder id -> { name, parents }
async function driveFolder(id) {
  if (!driveFolders.has(id)) driveFolders.set(id, driveGet(`files/${encodeURIComponent(id)}`, { fields: "name,parents", supportsAllDrives: "true" }).catch(() => null));
  return driveFolders.get(id);
}
// The file in Drive with the document's file name, in the folders it was uploaded from (as many of them,
// from the nearest up, as match). A name found once, or one place that matches best, is taken; "" when
// it is not found or cannot be told apart.
async function findInDrive(fileName) {
  const parts = String(fileName || "").split(" › ")[0].split("/").filter(Boolean);
  const base = parts.pop();
  if (!base) return "";
  const q = `name = '${base.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}' and trashed = false and mimeType != 'application/vnd.google-apps.folder'`;
  const { files = [] } = await driveGet("files", { q, fields: "files(id,parents)", pageSize: "20", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
  if (!files.length) return "";
  if (files.length === 1) return files[0].id;
  const scored = [];
  for (const f of files) {
    let score = 0, parent = f.parents?.[0];
    for (let i = parts.length - 1; i >= 0 && parent; i--) {
      const folder = await driveFolder(parent);
      if (!folder || folder.name !== parts[i]) break;
      score++;
      parent = folder.parents?.[0];
    }
    scored.push({ id: f.id, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored[0].score > 0 && scored[0].score > (scored[1]?.score ?? -1) ? scored[0].id : "";
}
// Links the documents not linked yet; -> { linked, missing }
async function linkToDrive(list, onStep) {
  let linked = 0, missing = 0;
  for (const [i, r] of list.entries()) {
    onStep?.(i, list.length);
    try {
      const id = await findInDrive(r.fileName);
      if (id) { await store.update(r.id, { driveId: id }); linked++; } else missing++;
    } catch (e) { if (/פג|אין חיבור/.test(e.message)) throw e; missing++; }
  }
  return { linked, missing };
}
const driveView = (id) => `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`;
const drivePreview = (id) => `https://drive.google.com/file/d/${encodeURIComponent(id)}/preview`;

$("driveLink").onclick = async () => {
  if (!store.driveToken) { toast("החיבור לדרייב עובד רק באתר עצמו"); return; }
  const list = [...records, ...miscDocs].filter((r) => inScope(r) && !r.driveId && r.fileName);
  if (!list.length) { toast("כל המסמכים כבר מקושרים לקבצים שלהם בדרייב"); return; }
  try {
    if (!(await driveToken())) return;
    const btn = $("driveLink");
    btn.disabled = true;
    const { linked, missing } = await linkToDrive(list, (i, n) => (btn.textContent = `🔗 מחפש בדרייב… ${i + 1} מתוך ${n}`));
    btn.disabled = false;
    btn.textContent = "🔗 קישור לקבצים בדרייב";
    toast(`קושרו ${linked} מסמכים לקבצים שלהם בדרייב${missing ? `. ${missing} לא נמצאו (בדקו שהם בדרייב של החשבון הזה)` : ""}`);
  } catch (e) { toast("החיבור לדרייב נכשל: " + e.message); $("driveLink").disabled = false; $("driveLink").textContent = "🔗 קישור לקבצים בדרייב"; }
};

// The whole file inside the document's window (every page), or back to the picture.
async function showWholeFile(r) {
  let id = r.driveId;
  if (!id) {
    if (!store.driveToken) { toast("החיבור לדרייב עובד רק באתר עצמו"); return; }
    try {
      if (!(await driveToken())) return;
      id = await findInDrive(r.fileName);
    } catch (e) { toast("החיבור לדרייב נכשל: " + e.message); return; }
    if (!id) { toast(`הקובץ "${(r.fileName || "").split("/").pop()}" לא נמצא בדרייב`); return; }
    try { await store.update(r.id, { driveId: id }); } catch { /* shown anyway */ }
  }
  const frame = $("dlgPreview").querySelector(".pic-frame") || $("dlgPreview");
  frame.innerHTML = `<iframe class="drive-frame" src="${drivePreview(id)}" title="הקובץ המלא" allow="autoplay"></iframe>`;
  $("dlgPreview").querySelectorAll(".pic-zoom button[data-zoom]:not([data-zoom=exit])").forEach((b) => (b.hidden = true));
  const tools = $("dlgPreview").querySelector(".pic-tools");
  if (tools && !tools.querySelector(".drive-out")) tools.insertAdjacentHTML("beforeend", `<a class="ghost drive-out" href="${driveView(id)}" target="_blank" rel="noopener">↗ פתיחה בדרייב</a>`);
}

// ---------- other documents (מסמכים שונים) ----------
// Documents of the client that are not expenses. Each keeps its picture and text, a name (from the file's
// name, to change), and its kind, told from its name and text where it can be.
const MISC_TYPES = [
  ["שכר דירה / חוזה שכירות", /שכר\s*דירה|שכ["״']?ד|חוזה\s*שכירות|הסכם\s*שכירות|שוכר|משכיר/],
  ["טופס 106", /106/],
  ["טופס 867", /867/],
  ["אישור ניכוי מס במקור", /ניכוי\s*(?:מס\s*)?במקור/],
  ["ביטוח לאומי", /ביטוח\s*לאומי|המוסד\s*לביטוח/],
  ["פנסיה וביטוחים", /פנסי|קרן\s*השתלמות|ביטוח\s*מנהלים|קופת\s*גמל|ביטוח\s*חיים/],
  ["משכנתא והלוואות", /משכנת|הלוואה|הלוואות/],
  ["אישור בנק / יתרות", /אישור\s*יתרה|יתרות|דף\s*חשבון|תדפיס/],
  ["רשות המסים", /רשות\s*המסים|מס\s*הכנסה|פקיד\s*שומה|שומה/],
];
const MISC_NAMES = [...MISC_TYPES.map(([n]) => n), "אחר"];
const miscTypeOf = (text, name) => (MISC_TYPES.find(([, re]) => re.test(name)) || MISC_TYPES.find(([, re]) => re.test(text)) || ["אחר"])[0];
const miscYear = (r) => (r.date || "").slice(0, 4) || (r.createdAt?.toDate ? String(r.createdAt.toDate().getFullYear()) : "");

function renderMisc() {
  const none = !client || client === ALL;
  $("miscNeedClient").hidden = !none;
  $("miscMain").hidden = none;
  if (none) return;
  const mine = miscDocs.filter(inScope);
  const keep = (id, opts) => {
    const cur = $(id).value;
    $(id).innerHTML = opts;
    if ([...$(id).options].some((o) => o.value === cur)) $(id).value = cur;
  };
  keep("mType", '<option value="">כל הסוגים</option>' + MISC_NAMES.filter((n) => mine.some((r) => r.docType === n)).map((n) => `<option>${esc(n)}</option>`).join(""));
  keep("mYear", '<option value="">כל השנים</option>' + [...new Set(mine.map(miscYear).filter(Boolean))].sort().reverse().map((y) => `<option>${esc(y)}</option>`).join(""));
  const type = $("mType").value, year = $("mYear").value;
  const rows = mine.filter((r) => (!type || r.docType === type) && (!year || miscYear(r) === year))
    .sort((a, b) => (b.date || "").localeCompare(a.date || "") || (a.title || "").localeCompare(b.title || "", "he"));
  $("mList").innerHTML = rows.map((r) => `<div class="g-card misc-card" data-id="${esc(r.id)}" draggable="true" title="אפשר לגרור אל &quot;מסמכי הוצאות&quot; או &quot;פקודות יומן&quot;">
      <div class="g-pic" data-mpic="${esc(r.id)}" title="לחיצה מגדילה"><small class="soon">טוען…</small></div>
      <div class="g-info">
        <input class="m-title" value="${esc(r.title || r.fileName || "")}" title="שם המסמך" aria-label="שם המסמך">
        <select class="m-type" aria-label="סוג המסמך">${MISC_NAMES.map((n) => `<option${n === r.docType ? " selected" : ""}>${esc(n)}</option>`).join("")}</select>
        <span class="g-foot"><small>${esc([showDate(r.date), r.fileName].filter(Boolean).join(" · "))}</small>
          <span><button type="button" class="ghost m-move" data-mmove="${esc(r.id)}" title="להעביר למסמכי ההוצאות ולרשום בפקודות היומן">➡️ להוצאות</button>
          <button type="button" class="ghost m-whole" data-mwhole="${esc(r.id)}" title="הקובץ המלא בדרייב">📄 כל הקובץ</button>
          <button type="button" class="icon-del" data-mdel="${esc(r.id)}" title="מחיקת המסמך" aria-label="מחיקת המסמך">🗑️</button></span></span>
      </div></div>`).join("");
  $("mEmpty").hidden = rows.length > 0;
  for (const r of rows) previewOf(r.id).then((src) => {
    const box = $("mList").querySelector(`[data-mpic="${CSS.escape(r.id)}"]`);
    if (box) box.innerHTML = src ? `<img src="${src}" alt="">` : '<small class="soon">אין תמונה</small>';
  });
}
$("mType").addEventListener("input", renderMisc);
$("mYear").addEventListener("input", renderMisc);
$("mList").addEventListener("click", async (e) => {
  const pic = e.target.closest("[data-mpic]");
  if (pic) { const src = await previewOf(pic.dataset.mpic); if (src) zoom(src); return; }
  const move = e.target.closest("[data-mmove]");
  if (move) { moveToExpenses(move.dataset.mmove); return; }
  const whole = e.target.closest("[data-mwhole]");
  if (whole) {
    const r = miscDocs.find((x) => x.id === whole.dataset.mwhole);
    if (!r) return;
    // opened now, so the browser lets the new tab through; its address comes when the file is found
    const tab = window.open("about:blank", "_blank");
    let id = r.driveId;
    try {
      if (!id && (await driveToken())) id = await findInDrive(r.fileName);
      if (id && !r.driveId) store.update(r.id, { driveId: id }).catch(() => {});
    } catch (err) { toast("החיבור לדרייב נכשל: " + err.message); }
    if (id) tab.location = driveView(id);
    else { tab?.close(); toast(`הקובץ "${r.fileName}" לא נמצא בדרייב`); }
    return;
  }
  const del = e.target.closest("[data-mdel]");
  if (!del) return;
  const r = miscDocs.find((x) => x.id === del.dataset.mdel);
  if (!r) return;
  // two questions, as with every deletion
  if (!(await askDeleteTwice(`למחוק מהתוכנה את "${r.title || r.fileName}"?`,
    "הרשומה והתמונה שלה יימחקו מהתוכנה לצמיתות, ואי אפשר יהיה לשחזר אותן. הקובץ המקורי נשאר בדרייב."))) return;
  try { await store.remove(r.id); previewCache.delete(r.id); toast("המסמך נמחק"); } catch (err) { toast("המחיקה נכשלה: " + err.message); }
});
$("mList").addEventListener("change", async (e) => {
  const card = e.target.closest("[data-id]");
  if (!card) return;
  const upd = e.target.classList.contains("m-title") ? { title: e.target.value.trim().slice(0, 150) }
    : e.target.classList.contains("m-type") ? { docType: e.target.value } : null;
  if (!upd) return;
  try { await store.update(card.dataset.id, upd); toast("נשמר"); } catch (err) { toast("השמירה נכשלה: " + err.message); }
});

// A document of the other documents that is an expense after all (a receipt uploaded there): dragged onto
// "מסמכי הוצאות" or "פקודות יומן" (or its "להוצאות" button), it is read as an expense from the text kept
// with it and becomes a line in the journal at once.
async function moveToExpenses(id) {
  const r = miscDocs.find((x) => x.id === id);
  if (!r) return;
  const [text = "", alt = ""] = String(r.text || "").split("\n----\n");
  const found = parseText(text, "", alt);
  const rec = {
    kind: "", client: r.client, customer: found.customer || "",
    date: found.date || r.date || "", supplier: found.supplier || "", supplierId: found.supplierId || "",
    category: found.category || "", docType: found.docType || "", docNo: found.docNo || "",
    amount: found.amount ?? null, vat: found.vat ?? null, details: found.details || "",
  };
  if (found.currency) {
    Object.assign(rec, { currency: found.currency, origAmount: rec.amount, origVat: rec.vat, amount: null, vat: null, rate: null, rateDate: "" });
    await convertCurrency(rec);
  }
  if (!rec.category) rec.category = learnedCategory(rec);
  // the date, account and service type from the file's folders and name, where the text did not tell them
  Object.assign(rec, fillFromPath({ ...rec, fileName: r.fileName }, `${text}\n${alt}`));
  const why = reviewReasons({ ...r, ...rec }, { exceptId: r.id });
  rec.status = why.length ? "review" : "ok";
  rec.reviewWhy = why.join(" · ");
  try {
    await store.update(r.id, rec);
    toast(`"${r.title || r.fileName}" הועבר למסמכי ההוצאות ונרשם בפקודות היומן${why.length ? " (מסומן לבדיקה)" : ""}`);
  } catch (err) { toast("ההעברה נכשלה: " + err.message); }
}
for (const view of ["docs", "journal"]) {
  const target = document.querySelector(`#sideNav > button[data-view="${view}"]`);
  target.addEventListener("dragover", (e) => {
    if (!e.dataTransfer.types.includes("application/x-fairy-misc")) return;
    e.preventDefault();
    target.classList.add("drop-here");
  });
  target.addEventListener("dragleave", () => target.classList.remove("drop-here"));
  target.addEventListener("drop", (e) => {
    const id = e.dataTransfer.getData("application/x-fairy-misc");
    target.classList.remove("drop-here");
    if (!id) return;
    e.preventDefault();
    moveToExpenses(id);
  });
}
$("mList").addEventListener("dragstart", (e) => {
  const card = e.target.closest(".misc-card");
  if (!card) return;
  e.dataTransfer.setData("application/x-fairy-misc", card.dataset.id);
  e.dataTransfer.effectAllowed = "move";
  document.body.classList.add("dragging-misc");
});
$("mList").addEventListener("dragend", () => document.body.classList.remove("dragging-misc"));

// Upload: read like any document (its picture and text), saved as the chosen client's other document.
$("mPick").onclick = (e) => { e.stopPropagation(); $("mFile").click(); };
$("mDrop").onclick = () => $("mFile").click();
$("mFile").onchange = (e) => { addMisc([...e.target.files]); e.target.value = ""; };
$("mDrop").addEventListener("dragover", (e) => { e.preventDefault(); $("mDrop").classList.add("over"); });
$("mDrop").addEventListener("dragleave", () => $("mDrop").classList.remove("over"));
$("mDrop").addEventListener("drop", (e) => { e.preventDefault(); $("mDrop").classList.remove("over"); addMisc([...e.dataTransfer.files]); });
async function addMisc(files) {
  if (!client || client === ALL) { toast("בחרו קודם לקוח"); return; }
  const who = client;
  for (const file of files) {
    const el = document.createElement("div");
    el.className = "item";
    el.innerHTML = `<div class="thumb"><span class="soon">⏳</span></div><div class="body"><span class="fname">${esc(file.name)}</span><div class="result">קורא…</div></div>`;
    $("mQueue").prepend(el);
    const say = (html, cls = "") => { el.className = `item ${cls}`; el.querySelector(".result").innerHTML = html; };
    let hash = "";
    try { hash = await fingerprint(file); } catch { /* without it a copy is not caught */ }
    // the same file again asks first, as in the expenses' intake
    const same = hash && miscDocs.find((r) => r.fileHash === hash && r.client === who);
    if (same && !confirm(`"${file.name}" כבר קיים במסמכים השונים של ${who} (בשם "${same.title}"). להעלות אותו שוב?`)) { say("⏭️ לא הועלה: כבר קיים", "dup"); continue; }
    let text = "", alt = "", preview = "";
    try { ({ text, alt = "", preview } = await oneAtATime(() => readFile(file, () => {}))); }
    catch (err) { say(`❌ לא נקרא: ${esc(err.message)}`, "failed"); continue; }
    if (preview) el.querySelector(".thumb").innerHTML = `<img src="${preview}" alt="">`;
    const all = [text, alt].filter(Boolean).join("\n----\n");
    const name = file.name.replace(/\.[^.]+$/, "");
    const rec = { client: who, kind: "misc", title: name.slice(0, 150), docType: miscTypeOf(all, name), date: parseText(text, "", alt).date || "",
      supplier: "", details: "", amount: null, vat: null, fileName: file.name, fileHash: hash, text: all.slice(0, 15000), status: "ok", reviewWhy: "" };
    try { await store.add(rec, preview); say(`✅ נשמר · ${esc(rec.docType)}${rec.date ? ` · ${showDate(rec.date)}` : ""}`, "saved"); }
    catch (err) { say(`❌ השמירה נכשלה: ${esc(err.message)}`, "failed"); }
  }
}

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
// The lines shown: an expense line with nothing in it stays (empty), except כיבוד, which shows only
// when there is some (it is not in the printed layout otherwise).
const filingExpenses = (f) => f.expenses.filter(([l, v]) => l !== "כיבוד" || v);

function filingHtml() {
  const f = buildFiling(filing.lines, filing);
  const row = (label, b = "", d = "", cls = "") => `<tr class="${cls}"><td>${esc(label)}</td><td class="num">${b}</td><td class="num">${d}</td></tr>`;
  const y = esc(String(filing.year));
  const exp = filingExpenses(f);
  return `<div class="filing-sheet">
    <h3>${esc(filing.client)}  - תעודת זהות ${esc(filing.idNumber || "")}</h3>
    <h3 class="fs-title">דוח הכנסות והוצאות לשנת המס ${y}</h3>
    <table>
      <thead><tr><th></th><th class="num">שקלים חדשים</th><th class="num">שקלים חדשים</th></tr></thead>
      <tbody>
        ${row("הכנסות", "", shekel(f.income), "b line")}
        ${row("", "", "", "gap")}
        ${f.stock ? row("שינויים במלאי", shekel(f.stock)) : ""}
        ${row("קניות אחרות", shekel(f.purchases), "", "under-b")}
        ${row("עלות ההכנסות", "", shekel(f.cost), "b line")}
        ${row("רווח גולמי", "", shekel(f.gross), "b")}
        ${row("", "", "", "gap")}
        ${row("הוצאות  מכירה הנהלה וכלליות", "", "", "b")}
        ${exp.map(([l, v], i) => row(l, v ? shekel(v) : "", "", i === exp.length - 1 ? "under-b" : "")).join("")}
        ${row("הוצאות מכירה הנהלה וכלליות", "", shekel(f.expenseTotal), "b line")}
        ${row(f.result < 0 ? "הפסד לשנה" : "רווח לשנה", "", signed(f.result), "b line")}
        ${row("", "", "", "gap")}
        ${row("תאומים", "", "", "b")}
        ${row("הוצאות רכב", shekel(f.carAdj), "", f.mealAdj ? "" : "under-b")}
        ${f.mealAdj ? row("כיבודים", shekel(f.mealAdj), "", "under-b") : ""}
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
for (const [id, key, isNum] of [["fId", "idNumber"], ["fCar", "carPct", true], ["fMeal", "mealPct", true]]) {
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
  const net = (r) => (dealerOf(r.client, r.date) === "licensed" && r.vat && r.vat < (r.amount || 0) ? r.amount - r.vat : r.amount || 0);
  const lines = comparativeFromDocs(records.filter((r) => inScope(r) && !isDonationDoc(r)), +filing.year, accountOf, accountName, net);
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
    $("shareList").querySelectorAll("button").forEach((b) => (b.onclick = async () => {
      // two questions before someone loses access
      if (!(await askDelete("הסרה מהשיתוף", `להסיר את ${b.dataset.e} מהשיתוף?`, { okLabel: "להסיר" }))) return;
      if (!(await askDelete("אישור שני ואחרון", `${b.dataset.e} לא יוכל יותר להיכנס למערכת ולראות את המסמכים.`, { second: true, okLabel: "כן, להסיר" }))) return;
      store.removeAccess(b.dataset.e);
    }));
  });
  $("shareDlg").showModal();
};
$("shareAdd").onclick = async () => {
  const email = $("shareEmail").value.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast("כתובת מייל לא תקינה"); return; }
  try { await store.addAccess(email); $("shareEmail").value = ""; toast("נוסף. שלחו לו את הקישור לאתר."); }
  catch (e) { toast("ההוספה נכשלה: " + e.message); }
};
