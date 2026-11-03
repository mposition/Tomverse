// Writes the assets a person approved to job/approved.json:
//   node list-approved.mjs
// The daily job builds new assets only from these (owner decision 2026-11-04).
// The app answers ids, kinds, channels, locales and validity -- no files.
//
// Exit codes: 0 written, 1 anything else.
import { mkdirSync, writeFileSync } from "node:fs";

const appUrl = process.env.MARKETING_APP_URL;
const secret = process.env.MARKETING_MEDIA_SUBMIT_SECRET;
if (!appUrl || !secret) {
  console.error("MARKETING_APP_URL and MARKETING_MEDIA_SUBMIT_SECRET must be set");
  process.exit(1);
}

const response = await fetch(new URL("/api/internal/marketing-assets/approved", appUrl), {
  headers: { authorization: `Bearer ${secret}` },
});
const body = await response.json().catch(() => ({}));
if (response.status !== 200 || !Array.isArray(body.result?.assets)) {
  console.error(JSON.stringify({ step: "list-approved", status: response.status, code: body.code ?? null }));
  process.exit(1);
}
mkdirSync("job", { recursive: true });
writeFileSync("job/approved.json", JSON.stringify(body.result.assets, null, 2));
console.log(JSON.stringify({ approved: body.result.assets.length }));
