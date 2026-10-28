// Writes rates.json: the Bank of Israel representative rates (שער יציג) of the dollar, the euro and the
// pound, by day, from 2018 on. The app looks up a foreign-currency payment's rate in it.
// The Bank of Israel answers code (no Origin header) but not a web page, so this runs here, before a deploy:
//   node scripts/update-rates.mjs
import { writeFileSync } from "fs";

const SOURCE = "https://edge.boi.gov.il/FusionEdgeServer/sdmx/v2/data/dataflow/BOI.STATISTICS/EXR/1.0/"
  + "?c%5BDATA_TYPE%5D=OF00&c%5BBASE_CURRENCY%5D=EUR,USD,GBP&locale=he";
const FROM = "2018-01-01";

const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`Bank of Israel answered ${res.status}`);
const xml = await res.text();
const rates = {};
for (const series of xml.split("<Series ").slice(1)) {
  const cur = series.match(/BASE_CURRENCY="([A-Z]{3})"/)?.[1];
  if (!cur || !/SERIES_CODE="RER_[A-Z]{3}_ILS"/.test(series)) continue;
  const days = (rates[cur] = {});
  for (const m of series.matchAll(/<Obs TIME_PERIOD="(\d{4}-\d{2}-\d{2})" OBS_VALUE="([\d.]+)"/g)) if (m[1] >= FROM) days[m[1]] = +m[2];
}
const last = Object.values(rates).flatMap((d) => Object.keys(d)).sort().pop();
if (!rates.USD || !last) throw new Error("no rates in the answer");
writeFileSync(new URL("../rates.json", import.meta.url), JSON.stringify({ source: "בנק ישראל - שער יציג", updated: last, rates }));
console.log(`rates.json: ${Object.entries(rates).map(([c, d]) => `${c} ${Object.keys(d).length}`).join(", ")}, last day ${last}`);
