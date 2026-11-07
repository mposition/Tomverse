import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ADMIN_NAVIGATION, ADMIN_UNLISTED_PAGES } from "../lib/adminNavigation.ts";
import { adminTrustSafetyMessages } from "../lib/adminMessages/trustSafety.ts";
import { TRUST_SAFETY_CONFIG_FAULTS } from "../lib/trustSafetyActivationCore.ts";

/**
 * E2: the section's registration and its read
 * (docs/policy/trust-safety-compliance-agent.md §5.6, §9).
 */

const READ = "lib/trustSafetyDigestRead.ts";
const PAGE = "app/(site)/(application)/admin/agent-digests/page.tsx";
const ACTIVATION_READ = "lib/trustSafetyActivationRead.ts";

const codeOf = (file) =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join("\n");

test("the section is a tab of the common digest area, not a page of its own", () => {
  // §9: the display is one section inside the common area, and a team-owned
  // digest screen is refused. docs/ui-contracts/admin-console-ia.md rule 2
  // puts a section in `?tab=`. Since 2026-11-07 the common area has no menu:
  // the other digests are the Release and Billing & finance pages, and this
  // section keeps the address it always had, as an unlisted page that renders
  // that one tab and redirects every other value.
  const page = ADMIN_UNLISTED_PAGES.find((candidate) => candidate.href === "/admin/agent-digests");
  assert.ok(page, "the common digest area is still a known page");
  assert.deepEqual(page.sections, ["trust-safety"]);
  assert.equal(ADMIN_NAVIGATION.some((entry) => entry.href === "/admin/agent-digests"), false);
  assert.match(codeOf(PAGE), /query\.tab !== "trust-safety"\) redirect\(/);
  assert.match(codeOf(PAGE), /<TrustSafetySection /);
});

test("the read refuses a caller without trust-safety:read, before reading", () => {
  // §6: reading is the owner's too, and the check is not hiding the section in
  // the UI -- it is made in the server component, in this read and in the
  // activation route, each fail-closed. Independent review found it missing
  // here: the console layout admits any administrator, so a support or
  // billing administrator could open the tab and read the counts.
  const code = codeOf(READ);
  assert.match(code, /hasAdminPermission\(session, "trust-safety:read"\)/);
  assert.match(code, /return \{ permitted: false \};/);
  // From the function, not the file: the import block names the transaction
  // wrapper first, and reading the file would compare against that.
  const body = code.slice(code.indexOf("export const readTrustSafetyDigest"));
  const check = body.indexOf("trust-safety:read");
  const transaction = body.indexOf("withTrustSafetyTransaction");
  assert.ok(check > 0 && check < transaction, "the permission is checked before anything is read");
  // Fail-closed: no session, not an admin session, or the wrong role.
  assert.match(code, /!session \|\| !isAdminSession\(session\)/);
});

test("the page checks the same permission before it renders the section", () => {
  // §6 asks for the check in each place rather than once: the page may not
  // draw values a reader is not allowed to see even if the read would refuse.
  assert.match(codeOf(PAGE), /hasAdminPermission\(session, "trust-safety:write"\)/);
  assert.match(codeOf(PAGE), /adminReauthenticationHref\(/);
  assert.match(codeOf(PAGE), /ADMIN_RECENT_AUTH_MODE/);
});

test("the two entry points test the ping URL the same way", () => {
  // A set-but-empty variable read as present in the section and absent in the
  // round, so the screen showed no fault while every round reported
  // `ping_url_missing` and withheld the ping. Independent review found the
  // pair disagreeing; §6's sixth fault has to mean one thing.
  const readCode = codeOf(READ);
  const roundCode = codeOf("lib/trustSafetyObserverRound.ts");
  assert.doesNotMatch(readCode, /typeof process\.env\.TRUST_SAFETY_OBSERVER_PING_URL === "string"/);
  assert.match(readCode, /pingUrlPresent: \(process\.env\.TRUST_SAFETY_OBSERVER_PING_URL \?\? ""\)\.length > 0/);
  // The round's own test is the same shape: a non-empty string.
  assert.match(roundCode, /isPresent\(process\.env\.TRUST_SAFETY_OBSERVER_PING_URL\)/);
  assert.match(roundCode, /typeof value === "string" && value\.length > 0/);
});

test("the read writes nothing at all", () => {
  // §5.6 gives E2 an empty write allowance: not a row, not an audit entry,
  // not an outgoing request.
  const code = codeOf(READ) + codeOf(ACTIVATION_READ);
  assert.doesNotMatch(code, /\.\s*(create|update|upsert|delete|createMany|updateMany)(Many)?\s*\(/);
  assert.doesNotMatch(code, /writeAdminAuditLog|writeSystemAuditLog/);
  assert.doesNotMatch(code, /\$executeRaw|\$queryRaw/);
  assert.doesNotMatch(code, /\bfetch\s*\(/);
});

test("the read never touches the run table", () => {
  // §5.3: nothing reads it, which is what makes the row a record rather than
  // state. A "last successful round" line would be its first reader.
  const code = codeOf(READ) + codeOf(ACTIVATION_READ);
  assert.doesNotMatch(code, /TrustSafetyObserverRun|trustSafetyObserverRun/);
});

test("the read uses the observer's own bounded transactions", () => {
  // The screen is held to the same ceilings and the same deadline as the
  // round (§5.5), rather than opening an unbounded read of its own.
  const code = codeOf(READ);
  assert.match(code, /withTrustSafetyTransaction\(\{[\s\S]*?kind: "activation_read"/);
  assert.match(code, /kind: "dsr_read"/);
  assert.doesNotMatch(code, /prisma\.\$transaction|prisma\./);
});

test("the counts are skipped when §6 does not permit counting", () => {
  const code = codeOf(READ);
  assert.match(code, /if \(!state\.activation\.countPermitted\)/);
  const guard = code.indexOf("countPermitted");
  const dsr = code.indexOf('kind: "dsr_read"');
  assert.ok(guard < dsr, "the guard comes before the count read");
});

test("one activation read serves both entry points", () => {
  // E1 and E2 judging the chain with different code is how a screen comes to
  // disagree with the round about whether the switch is believed.
  for (const file of ["lib/trustSafetyObserverRound.ts", READ]) {
    assert.match(codeOf(file), /readTrustSafetyActivation\(/, file);
  }
  const shared = codeOf(ACTIVATION_READ);
  assert.match(shared, /deriveTrustSafetyActivation\(/);
  // And neither caller derives it a second time of its own.
  assert.doesNotMatch(codeOf(READ), /deriveTrustSafetyActivation\(/);
  assert.doesNotMatch(codeOf("lib/trustSafetyObserverRound.ts"), /deriveTrustSafetyActivation\(/);
});

test("every fault §6 can report has copy in both languages", () => {
  // A fault with no copy renders its own identifier, which is the one thing
  // the operator cannot act on.
  for (const fault of TRUST_SAFETY_CONFIG_FAULTS) {
    for (const locale of ["en", "ko"]) {
      const catalogue = locale === "en" ? adminTrustSafetyMessages.en : adminTrustSafetyMessages.ko;
      assert.ok(
        typeof catalogue[`fault_${fault}`] === "string",
        `${locale} is missing fault_${fault}`,
      );
    }
  }
  assert.equal(TRUST_SAFETY_CONFIG_FAULTS.length, 6, "six faults, as §6 counts them");
});

test("the two catalogues define the same keys", () => {
  const en = Object.keys(adminTrustSafetyMessages.en).sort();
  const ko = Object.keys(adminTrustSafetyMessages.ko).sort();
  assert.deepEqual(ko, en);
});

test("the page settles the read on its own and reports a loss", () => {
  // docs/ui-contracts/admin-console-ia.md rule 5: a workspace degrades the
  // section that failed and leaves the rest usable, and a failed read is
  // reported rather than absorbed.
  const code = codeOf(PAGE);
  assert.match(code, /admin_agent_digests_read_failed/);
  assert.match(code, /console\.warn/);
  assert.match(code, /return null;/);
});

test("the section's copy is resolved by the page, not by its own files", () => {
  // §5.6 closes these files' imports, and the locale helpers are not among
  // them -- so the panel takes its messages as a prop.
  assert.match(codeOf(PAGE), /getAdminMessages\(adminTrustSafetyMessages\)/);
  const panel = codeOf("components/admin/AdminTrustSafetyDigestPanel.tsx");
  assert.doesNotMatch(panel, /useAdminMessages|adminLocale|next\/headers/);
  assert.match(panel, /messages: m/);
});
