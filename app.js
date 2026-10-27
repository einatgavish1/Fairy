import { firebaseConfig, OWNER_EMAILS } from "./firebase-config.js";
import { readFile, parseText, CATEGORY_NAMES, DOC_TYPE_NAMES } from "./extract.js?v=1";

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
    watchAccess: (cb) => fs.onSnapshot(fs.collection(db, "access"), (snap) => cb(snap.docs.map((d) => d.id))),
    addAccess: (email) => fs.setDoc(fs.doc(db, "access", email), { addedAt: fs.serverTimestamp(), addedBy: auth.currentUser.email }),
    removeAccess: (email) => fs.deleteDoc(fs.doc(db, "access", email)),
  };
} else {
  const KEY = "fairy-docs", PKEY = "fairy-preview-";
  const listeners = new Set();
  const read = () => { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; } };
  const write = (all) => { localStorage.setItem(KEY, JSON.stringify(all)); listeners.forEach((cb) => cb(read())); };
  store = {
    watch(cb) { listeners.add(cb); cb(read()); return () => listeners.delete(cb); },
    async add(rec, preview) {
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      write([...read(), { ...rec, id, createdAt: new Date().toISOString() }]);
      try { if (preview) localStorage.setItem(PKEY + id, preview); } catch { /* the browser's space is small; keep the details anyway */ }
      return id;
    },
    async update(id, rec) { write(read().map((r) => (r.id === id ? { ...r, ...rec } : r))); },
    async remove(id) { localStorage.removeItem(PKEY + id); write(read().filter((r) => r.id !== id)); },
    async preview(id) { return localStorage.getItem(PKEY + id) || ""; },
  };
}

// ---------- sign-in ----------

let user = null, records = [], unsub = null;

function layered(el, depth = 10) {
  el.innerHTML = [...el.textContent].map((ch, i) => ch === " "
    ? '<span class="sp"> </span>'
    : `<span class="L" style="--i:${i}">${Array.from({ length: depth }, (_, k) =>
        `<b style="--k:${k}"${k ? ' aria-hidden="true"' : ""}>${ch}</b>`).join("")}</span>`).join("");
}
layered($("fairyText"), 14);
layered($("sloganText"));

function showLogin(err = "") {
  if (unsub) { unsub(); unsub = null; }
  $("loginErr").textContent = err;
  $("appView").hidden = true;
  $("loginView").hidden = false;
}

function enterApp() {
  $("loginView").hidden = true;
  $("appView").hidden = false;
  $("userEmail").textContent = user?.email || "";
  $("modeNote").hidden = CLOUD;
  $("logoutBtn").hidden = !CLOUD;
  $("shareBtn").hidden = !(CLOUD && OWNER_EMAILS.includes(user.email));
  unsub = store.watch((all) => { records = all; renderAll(); }, (err) => showLogin(err.code === "permission-denied"
    ? `לחשבון ${user.email} אין הרשאה. בקשו מהבעלים לשתף אתכם.`
    : "שגיאה בטעינת הנתונים: " + err.message));
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

// ---------- menu ----------

function showView(name) {
  document.querySelectorAll("#sideNav > button[data-view]").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  document.querySelectorAll(".view-panel").forEach((p) => p.classList.toggle("view-active", p.dataset.view === name));
}
document.querySelectorAll("#sideNav > button[data-view]").forEach((b) => (b.onclick = () => showView(b.dataset.view)));

// ---------- the form fields of a document ----------

const FIELDS = [
  { k: "client", label: "לקוח", list: "clientList" },
  { k: "date", label: "תאריך", type: "date", need: true },
  { k: "supplier", label: "ספק", need: true },
  { k: "supplierId", label: "ח.פ / ע.מ" },
  { k: "category", label: "סוג שירות", list: "catList", need: true },
  { k: "docType", label: "סוג מסמך", options: DOC_TYPE_NAMES },
  { k: "docNo", label: "מספר מסמך" },
  { k: "amount", label: "סכום כולל מע״מ (₪)", type: "number", need: true },
  { k: "vat", label: "מע״מ (₪)", type: "number" },
  { k: "details", label: "פירוט", wide: true },
];

function fieldsHtml(v) {
  return FIELDS.map((f) => {
    const val = v[f.k] ?? "";
    const input = f.options
      ? `<select name="${f.k}"><option value=""></option>${f.options.map((o) => `<option${o === val ? " selected" : ""}>${o}</option>`).join("")}</select>`
      : `<input name="${f.k}" type="${f.type || "text"}" value="${esc(val)}"${f.list ? ` list="${f.list}" autocomplete="off"` : ""}${f.type === "number" ? ' step="0.01" inputmode="decimal" dir="ltr"' : ""}>`;
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

// A record that probably is this same document, already saved.
function findDuplicate(r, exceptId) {
  return records.find((x) => x.id !== exceptId && (
    (r.docNo && x.docNo === r.docNo && (x.supplier === r.supplier || x.supplierId === r.supplierId)) ||
    (r.amount && x.amount === r.amount && x.date === r.date && x.supplier === r.supplier)));
}

// ---------- intake ----------

const drop = $("drop");
$("fileInput").onchange = (e) => { addFiles(e.target.files); e.target.value = ""; };
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); addFiles(e.dataTransfer.files); });
// Pasting a screenshot (Ctrl+V) works too.
document.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length && !$("appView").hidden) { showView("upload"); addFiles(files); }
});

const pending = new Set();
function syncSaveAll() { $("saveAllBtn").hidden = [...pending].filter((it) => it.ready).length < 2; }
$("saveAllBtn").onclick = async () => { for (const it of [...pending]) if (it.ready) await it.save(); };

function addFiles(list) {
  for (const file of list) {
    if (!/pdf|image/.test(file.type) && !/\.(pdf|jpe?g|png|webp|gif|bmp)$/i.test(file.name)) { toast(`${file.name}: אפשר רק PDF או תמונה`); continue; }
    processFile(file);
  }
}

async function processFile(file) {
  const el = document.createElement("div");
  el.className = "item";
  el.innerHTML = `<div class="thumb"><span class="soon">⏳</span><span class="fname">${esc(file.name)}</span></div>
    <div class="body"><div class="status"><span class="label">ממתין…</span><div class="bar"><i></i></div></div></div>`;
  $("queue").prepend(el);
  const status = (p, label) => {
    el.querySelector(".bar i").style.width = Math.round(p * 100) + "%";
    if (label) el.querySelector(".label").textContent = label;
  };
  const item = { ready: false };
  pending.add(item);
  try {
    const { text, preview, ocr } = await readFile(file, status);
    const thumb = el.querySelector(".thumb");
    thumb.innerHTML = `${preview ? `<img src="${preview}" alt="">` : '<span class="soon">אין תצוגה</span>'}<span class="fname">${esc(file.name)}</span>`;
    thumb.onclick = () => preview && zoom(preview);
    const found = { client: $("defaultClient").value.trim(), ...parseText(text) };
    const missing = FIELDS.filter((f) => f.need && !found[f.k]).length;
    el.querySelector(".body").innerHTML = `
      <div class="fields">${fieldsHtml(found)}</div>
      <div class="item-actions">
        <button class="primary save">שמירה</button>
        <button class="ghost drop-it">הסרה</button>
        <span class="note">${!text.trim() ? "⚠️ לא נמצא טקסט במסמך. אפשר למלא ידנית." : missing ? `זוהו רוב הפרטים, ${missing} חסרים (מסומנים בצהוב)` : "✨ כל הפרטים זוהו. כדאי להציץ ולוודא."}</span>
      </div>
      <details class="raw"><summary>הטקסט שזוהה${ocr ? " (זיהוי מתמונה)" : ""}</summary><pre>${esc(text)}</pre></details>`;
    const box = el.querySelector(".fields");
    bindFields(box);
    item.ready = true;
    item.save = async () => {
      const rec = readFields(box);
      if (!rec.amount && !rec.supplier) { toast("חסרים ספק וסכום"); return; }
      const dup = findDuplicate(rec);
      if (dup && !confirm(`נראה שהמסמך הזה כבר נקלט (${dup.supplier}, ${showDate(dup.date)}, ${fmt(dup.amount)}). לשמור בכל זאת?`)) return;
      const btn = el.querySelector(".save");
      btn.disabled = true;
      try {
        await store.add({ ...rec, fileName: file.name }, preview);
        pending.delete(item);
        item.ready = false;
        el.classList.add("saved");
        box.querySelectorAll("input,select").forEach((i) => (i.disabled = true));
        el.querySelector(".item-actions").innerHTML = '<span class="saved-note">✓ נשמר</span><button class="ghost drop-it">הסתרה</button>';
        el.querySelector(".drop-it").onclick = () => el.remove();
        syncSaveAll();
      } catch (e) {
        btn.disabled = false;
        toast("השמירה נכשלה: " + e.message);
      }
    };
    el.querySelector(".save").onclick = item.save;
    el.querySelector(".drop-it").onclick = () => { pending.delete(item); el.remove(); syncSaveAll(); };
  } catch (e) {
    pending.delete(item);
    el.querySelector(".body").innerHTML = `<p class="err">לא הצלחתי לקרוא את ${esc(file.name)}: ${esc(e.message)}</p><button class="ghost drop-it">הסרה</button>`;
    el.querySelector(".drop-it").onclick = () => el.remove();
  }
  syncSaveAll();
}

function zoom(src) {
  $("imgBig").src = src;
  $("imgDlg").showModal();
}

// ---------- documents list ----------

let sortDir = -1;
const filters = ["search", "clientFilter", "catFilter", "monthFilter"];
filters.forEach((id) => $(id).addEventListener("input", renderTable));
document.querySelector("th.sort").onclick = () => { sortDir = -sortDir; renderTable(); };

function fillSelect(sel, values, allLabel) {
  const cur = sel.value;
  sel.innerHTML = `<option value="">${allLabel}</option>` + values.map((v) => `<option>${esc(v)}</option>`).join("");
  sel.value = values.includes(cur) ? cur : "";
}

function renderAll() {
  const clients = [...new Set(records.map((r) => r.client).filter(Boolean))].sort((a, b) => a.localeCompare(b, "he"));
  const cats = [...new Set([...CATEGORY_NAMES, ...records.map((r) => r.category).filter(Boolean)])];
  $("clientList").innerHTML = clients.map((c) => `<option value="${esc(c)}">`).join("");
  $("catList").innerHTML = cats.map((c) => `<option value="${esc(c)}">`).join("");
  fillSelect($("clientFilter"), clients, "כל הלקוחות");
  fillSelect($("sumClient"), clients, "כל הלקוחות");
  fillSelect($("catFilter"), [...new Set(records.map((r) => r.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, "he")), "כל סוגי השירות");
  const years = [...new Set(records.map((r) => (r.date || "").slice(0, 4)).filter(Boolean))].sort().reverse();
  const curYear = $("sumYear").value;
  $("sumYear").innerHTML = years.map((y) => `<option>${y}</option>`).join("") || `<option>${new Date().getFullYear()}</option>`;
  if (years.includes(curYear)) $("sumYear").value = curYear;
  renderTable();
  renderSummary();
}

function filtered() {
  const q = $("search").value.trim().toLowerCase();
  const client = $("clientFilter").value, cat = $("catFilter").value, month = $("monthFilter").value;
  return records.filter((r) =>
    (!client || r.client === client) && (!cat || r.category === cat) && (!month || (r.date || "").startsWith(month)) &&
    (!q || [r.supplier, r.supplierId, r.details, r.docNo, r.client, r.category, r.fileName].some((v) => String(v || "").toLowerCase().includes(q))))
    .sort((a, b) => sortDir * (a.date || "").localeCompare(b.date || ""));
}

function renderTable() {
  const rows = filtered();
  $("sortArrow").textContent = sortDir < 0 ? "▼" : "▲";
  $("rows").innerHTML = rows.map((r) => `<tr data-id="${r.id}">
    <td class="num">${showDate(r.date)}</td>
    <td>${esc(r.client)}</td>
    <td>${esc(r.supplier)}${r.details ? `<small>${esc(r.details)}</small>` : ""}</td>
    <td>${r.category ? `<span class="tag">${esc(r.category)}</span>` : ""}</td>
    <td>${esc(r.docType)}${r.docNo ? `<small>מס׳ ${esc(r.docNo)}</small>` : ""}</td>
    <td class="num">${r.vat ? fmt(r.vat) : ""}</td>
    <td class="num">${fmt(r.amount)}</td></tr>`).join("");
  $("rows").querySelectorAll("tr").forEach((tr) => (tr.onclick = () => openEntry(tr.dataset.id)));
  const sum = (k) => round2(rows.reduce((s, r) => s + (r[k] || 0), 0));
  $("shownSum").textContent = fmt(sum("amount"));
  $("shownVat").textContent = fmt(sum("vat"));
  $("sumCount").textContent = rows.length;
  $("sumTotal").textContent = fmt(sum("amount"));
  $("sumVat").textContent = fmt(sum("vat"));
  $("sumNet").textContent = fmt(round2(sum("amount") - sum("vat")));
  $("emptyMsg").hidden = records.length > 0;
}

let editing = null;
async function openEntry(id) {
  const r = records.find((x) => x.id === id);
  if (!r) return;
  editing = id;
  const box = $("dlgFields");
  box.innerHTML = fieldsHtml(r);
  bindFields(box);
  $("dlgPreview").innerHTML = '<p class="soon">טוען תמונה…</p>';
  $("entryDlg").showModal();
  const src = await store.preview(id);
  if (editing !== id) return;
  $("dlgPreview").innerHTML = src ? `<img src="${src}" alt="">` : '<p class="soon">אין תמונה שמורה</p>';
  const img = $("dlgPreview").querySelector("img");
  if (img) img.onclick = () => zoom(src);
}
$("entryForm").onsubmit = async (e) => {
  e.preventDefault();
  try { await store.update(editing, readFields($("dlgFields"))); $("entryDlg").close(); toast("נשמר"); }
  catch (err) { toast("השמירה נכשלה: " + err.message); }
};
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
    "לפני מע״מ": net(r), "מע״מ": r.vat || 0, "סכום כולל": r.amount || 0, "קובץ": r.fileName,
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  ws["!cols"] = [10, 16, 26, 12, 16, 16, 12, 30, 12, 10, 12, 24].map((wch) => ({ wch }));
  const wb = XLSX.utils.book_new();
  wb.Workbook = { Views: [{ RTL: true }] };
  XLSX.utils.book_append_sheet(wb, ws, "מסמכים");
  XLSX.writeFile(wb, `Fairy מסמכים ${new Date().toISOString().slice(0, 10)}.xlsx`);
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
  const year = $("sumYear").value, client = $("sumClient").value;
  const rows = records.filter((r) => (r.date || "").startsWith(year) && (!client || r.client === client));
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
