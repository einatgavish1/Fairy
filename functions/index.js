// Reads one invoice or receipt with Claude on Google Cloud (Vertex AI): the app sends the document's
// picture (and where the file was kept), Claude returns its details. Only a signed-in owner, or someone
// the owners shared the app with, can call it. No key: the function signs in to Vertex AI as the
// project's own service account, and it is billed with the rest of the Firebase project.
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";

initializeApp();
// Made on the first call, not when the file loads: signing in needs Google Cloud around it.
let vertex = null;
const claude = () => (vertex ??= new AnthropicVertex({ projectId: process.env.GCLOUD_PROJECT || "fairy-36dc8", region: "global" }));
// Keep in step with OWNER_EMAILS in firebase-config.js and isOwner() in firestore.rules.
const OWNERS = ["einatgavish1@gmail.com", "gavishori@gmail.com"];

async function allowed(token) {
  if (!token?.email || token.email_verified !== true || token.firebase?.sign_in_provider !== "google.com") return false;
  if (OWNERS.includes(token.email)) return true;
  return (await getFirestore().doc(`access/${token.email.toLowerCase()}`).get()).exists;
}

const SYSTEM = `You read Israeli invoices and receipts (mostly in Hebrew) for an accountant, Einat Gavish.
Her clients are small exempt dealers (עוסק פטור), so every document is an expense of the client, and the
amount that matters is the full amount paid, VAT included.

From the picture, fill in:
- supplier: the business that issued the document, as printed at the top or in its logo (for example
  "אלון לטרון", "סטימצקי", "כלבו קיבוץ רעים"). Never the customer: the name after "לכבוד" is the customer.
  No times, dates, cash-register numbers or labels in it.
- supplierId: the issuer's company or dealer number (ח.פ / ע.מ / עוסק מורשה), digits only.
- customer: the name after "לכבוד" (or "שם הלקוח"), as printed; empty when there is none.
- date: the document's date as YYYY-MM-DD. Israeli dates are day/month/year ("08/07/25" is 2025-07-08).
- amount: the total paid including VAT ("סה"כ לתשלום", "סה"כ כולל מע"מ", the card charge). Not a line
  item, not the number of items, not change given back.
- vat: the VAT amount (מע"מ) when printed, otherwise null.
- docType: the document's type as printed. "קבלה/חשבונית מס" or "חשבונית מס קבלה" is "חשבונית מס קבלה".
- docNo: the document's own number (מספר חשבונית / קבלה / מסמך), not a card or transaction number.
- details: what was bought, in a few Hebrew words (for example "משקה סויה, ופל, טישו").
- category: the service type, from the list.
- account: the expense account by the kind of item bought, from the chart of accounts. Food and drink for
  the clinic is refreshments (כיבודים); fuel is car fuel; books are professional literature.
  The folders the file was kept in are the client's own filing and usually say what kind of expense it is,
  but the items on the document come first when they plainly say otherwise.
- unclear: the fields you could not read with confidence (empty when all is clear).

Leave a field empty (or null) rather than guess when it cannot be read.`;

const str = (max) => ({ type: "string", maxLength: max });
function schema(docTypes, categories, accounts) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["supplier", "supplierId", "customer", "date", "amount", "vat", "docType", "docNo", "details", "category", "account", "unclear"],
    properties: {
      supplier: str(80), supplierId: str(12), customer: str(80), date: str(10),
      amount: { anyOf: [{ type: "number" }, { type: "null" }] },
      vat: { anyOf: [{ type: "number" }, { type: "null" }] },
      docType: { type: "string", enum: ["", ...docTypes] },
      docNo: str(20), details: str(120),
      category: { type: "string", enum: ["", ...categories] },
      account: { type: "string", enum: accounts.map(([code]) => code) },
      unclear: { type: "array", items: { type: "string", enum: ["supplier", "supplierId", "customer", "date", "amount", "vat", "docType", "docNo", "account"] } },
    },
  };
}

// The lists come from the app (its own document types, service types and chart of accounts).
const list = (v, max, test) => Array.isArray(v) && v.length > 0 && v.length <= max && v.every(test);
const short = (s) => typeof s === "string" && s.length > 0 && s.length <= 80;

export const readDocument = onCall(
  { region: "me-west1", timeoutSeconds: 120, memory: "512MiB", maxInstances: 5 },
  async (request) => {
    if (!(await allowed(request.auth?.token))) throw new HttpsError("permission-denied", "אין הרשאה");
    const { image, path = "", docTypes, categories, accounts } = request.data || {};
    const m = typeof image === "string" && image.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
    if (!m || image.length > 3_000_000) throw new HttpsError("invalid-argument", "תמונה לא תקינה");
    if (typeof path !== "string" || path.length > 500
        || !list(docTypes, 20, short) || !list(categories, 60, short)
        || !list(accounts, 300, (a) => Array.isArray(a) && /^\d{6}$/.test(a[0]) && short(a[1]))) {
      throw new HttpsError("invalid-argument", "בקשה לא תקינה");
    }

    const chart = accounts.map(([code, name]) => `${code} ${name}`).join("\n");
    const ask = (model) => claude().messages.create({
      model,
      max_tokens: 16000,
      output_config: { effort: "medium", format: { type: "json_schema", schema: schema(docTypes, categories, accounts) } },
      system: SYSTEM,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: `image/${m[1]}`, data: m[2] } },
          { type: "text", text: `Where the file was kept: ${path || "(unknown)"}\n\nChart of accounts:\n${chart}` },
        ],
      }],
    });
    let response;
    try {
      response = await ask("claude-opus-5-5");
      // A request the model declines is tried once more on Claude Opus 5.
      if (response.stop_reason === "refusal") response = await ask("claude-opus-5");
    } catch (e) {
      console.error("Vertex AI:", e.status, e.message);
      if (e.status === 429) throw new HttpsError("resource-exhausted", "יותר מדי בקשות, נסו שוב בעוד רגע");
      if (e.status === 401 || e.status === 403 || e.status === 404) throw new HttpsError("failed-precondition", "Claude לא הופעל בפרויקט ב-Google Cloud");
      throw new HttpsError("unavailable", `שירות הקריאה לא זמין${e.status ? ` (${e.status})` : ""}`);
    }
    if (response.stop_reason === "refusal") throw new HttpsError("aborted", "המסמך לא נקרא");
    const text = response.content.find((b) => b.type === "text")?.text;
    if (!text) throw new HttpsError("internal", "לא התקבלה תשובה");
    try { return JSON.parse(text); } catch { throw new HttpsError("internal", "תשובה לא תקינה"); }
  },
);
