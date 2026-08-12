import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  SETTINGS_SECTION_IDS,
  SETTINGS_SECTION_TAB,
  isSettingsSectionId,
  settingsSectionHref,
} from "../lib/settingsNavigation.ts";
import { en } from "../locales/en.ts";
import { ko } from "../locales/ko.ts";

// The export API shipped with nothing linking to it, so PRIVACY-02's actual
// requirement -- that a user can obtain their data -- was unmet however correct
// the backend was. These assertions are about the surface existing and staying
// wired, which is the part that was missing rather than the part that was hard.

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const component = read("../components/privacy/AccountDataDownload.tsx");
const page = read("../app/(site)/(application)/settings/data/page.tsx");
const settingsList = read("../components/auth/AuthButton.tsx");
const route = read("../app/api/user/account/export/route.ts");

test("the settings list links to the page, and the page renders the component", () => {
  assert.match(settingsList, /href="\/settings\/data"/);
  assert.match(settingsList, /section="account-data"/);
  assert.match(page, /AccountDataDownload/);
});

// A detail page that is not a registered section has no way back to the row the
// visitor came from -- SettingsDetailNav resolves its destination from this id.
test("account-data is a registered settings section in the data tab", () => {
  assert.ok(SETTINGS_SECTION_IDS.includes("account-data"));
  assert.equal(isSettingsSectionId("account-data"), true);
  assert.equal(SETTINGS_SECTION_TAB["account-data"], "data");
  assert.match(settingsSectionHref("account-data"), /settings=data.*settingsSection=account-data/);
  assert.match(component, /section="account-data"/);
});

test("every string the surface renders exists in English and Korean", () => {
  const keys = [...component.matchAll(/t\(\s*"(accountDataExport\.[\w.]+)"/g)].map((m) => m[1]);
  const formatted = [...component.matchAll(/formatCopy\(\s*"(accountDataExport\.[\w.]+)"/g)].map(
    (m) => m[1]
  );
  const all = [...new Set([...keys, ...formatted])];
  assert.ok(all.length >= 10, `only ${all.length} strings found`);

  const lookup = (dictionary, key) =>
    key.split(".").reduce((value, part) => (value ? value[part] : undefined), dictionary);

  for (const key of all) {
    assert.equal(typeof lookup(en, key), "string", `en is missing ${key}`);
    assert.equal(typeof lookup(ko, key), "string", `ko is missing ${key}`);
  }
});

// Status labels are looked up dynamically from the row's status, so a status
// the server can emit with no string renders as a raw key.
test("every status the server can record has a label", () => {
  for (const status of ["issued", "downloaded", "refused"]) {
    assert.equal(typeof en.accountDataExport.status[status], "string", `en: ${status}`);
    assert.equal(typeof ko.accountDataExport.status[status], "string", `ko: ${status}`);
  }
  // The set the migration's CHECK constraint allows.
  const migration = read(
    "../prisma/migrations/20260806000000_account_data_export_request/migration.sql"
  );
  const allowed = [...migration.matchAll(/'(issued|downloaded|refused)'/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(allowed)].sort(),
    Object.keys(en.accountDataExport.status).sort()
  );
});

// The two properties the flow exists to give the user, both of which are only
// true if the page says so: the link dies, and it dies soon.
test("the page tells the user the link is single-use and expiring", () => {
  assert.match(component, /linkExpiresIn/);
  assert.match(component, /linkExpired/);
  assert.match(en.accountDataExport.linkExpiresIn, /\{remaining\}/);
  assert.match(ko.accountDataExport.linkExpiresIn, /\{remaining\}/);
  assert.match(en.accountDataExport.linkExpiresIn, /once/);
  // A countdown that renders a negative time would be worse than none.
  assert.match(component, /Math\.max\(0,/);
});

test("the step-up refusal is handled as its own state, not as a generic error", () => {
  assert.match(component, /response\.status === 428/);
  assert.match(component, /reauthRequired/);
});

// A refusal row is how somebody learns a link of theirs was presented by
// someone else. Listing only successes would hide exactly the case worth
// showing.
test("the history surfaces refusals, not only downloads", () => {
  assert.match(component, /entry\.status === "refused"/);
  assert.match(component, /refusedNote/);
});

// The history endpoint reads the same table the download route writes; it must
// not become a way to read the download credential back out.
test("the history endpoint is a projection, never the token or the device", () => {
  const tickets = read("../lib/accountDataExportTickets.ts");
  const history = tickets.slice(
    tickets.indexOf("listAccountDataExportHistory"),
    tickets.indexOf("purgeExpiredAccountDataExportRequests")
  );
  for (const column of [
    "tokenHash",
    "issuedIpHash",
    "issuedUserAgentHash",
    "consumedIpHash",
    "consumedUserAgentHash",
  ]) {
    assert.equal(
      new RegExp(`\\b${column}\\s*:\\s*true`).test(history),
      false,
      `the history selects ${column}`
    );
  }
  assert.match(history, /select:/, "the history has no field allowlist");
});

// Deliberately not step-up gated: it is the trail somebody consults when they
// suspect another person is in the account, and putting it behind a fresh
// sign-in would guard it with the door the attacker already opened.
test("reading the history needs a session and a rate limit, but not a step-up", () => {
  const getAt = route.indexOf("export async function GET");
  const postAt = route.indexOf("export async function POST");
  assert.ok(getAt > 0 && postAt > getAt, "expected GET to be declared before POST");

  const get = route.slice(getAt, postAt);
  assert.match(get, /getServerSession/);
  assert.match(get, /consumeApiRateLimit/);
  assert.match(get, /"Cache-Control": "no-store"/);

  // The step-up is asserted by call site rather than by slice: the prose above
  // POST names the helper, and matching on the name alone would fail on a
  // comment. Issuing a link is gated; reading the history is not.
  const stepUps = [...route.matchAll(/await assertRecentAdminAuthentication\(session\)/g)];
  assert.equal(stepUps.length, 1, "expected exactly one step-up call in this route");
  assert.ok(stepUps[0].index > postAt, "the history read is behind a step-up");
});
