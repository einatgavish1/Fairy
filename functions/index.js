// Reads one invoice or receipt with Claude: the app sends the document's picture (and where the file was
// kept), Claude returns its details. Only a signed-in owner, or someone the owners shared the app with,
// can call it; the Anthropic key stays in Secret Manager and never reaches the browser.
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import Anthropic from "@anthropic-ai/sdk";

initializeApp();
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
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
  { region: "me-west1", secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 120, memory: "512MiB", maxInstances: 5 },
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

    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
    const chart = accounts.map(([code, name]) => `${code} ${name}`).join("\n");
    let response;
    try {
      response = await client.beta.messages.create({
        model: "claude-opus-5-5",
        max_tokens: 16000,
        // A declined request is retried on the model Anthropic recommends for it.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
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
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError) throw new HttpsError("resource-exhausted", "יותר מדי בקשות, נסו שוב בעוד רגע");
      if (e instanceof Anthropic.AuthenticationError) throw new HttpsError("failed-precondition", "מפתח ה-API של Anthropic לא תקין");
      if (e instanceof Anthropic.APIError) throw new HttpsError("unavailable", `שירות הקריאה לא זמין (${e.status})`);
      throw new HttpsError("internal", "הקריאה נכשלה");
    }
    if (response.stop_reason === "refusal") throw new HttpsError("aborted", "המסמך לא נקרא");
    const text = response.content.find((b) => b.type === "text")?.text;
    if (!text) throw new HttpsError("internal", "לא התקבלה תשובה");
    try { return JSON.parse(text); } catch { throw new HttpsError("internal", "תשובה לא תקינה"); }
  },
);
