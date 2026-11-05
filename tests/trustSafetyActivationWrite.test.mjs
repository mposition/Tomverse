import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ACTIVATION_REFUSALS,
  TRUST_SAFETY_ACTIVATION_ACTION,
  nextActivationWrite,
} from "../lib/trustSafetyActivationCore.ts";
import { TRUST_SAFETY_BOUNDS } from "../lib/trustSafetyBoundsCore.ts";

/**
 * E3, the person's activation write
 * (docs/policy/trust-safety-compliance-agent.md §5.6, §6).
 *
 * The decision is pure and is tested as such. The wiring -- one transaction
 * holding the config row and its audit entry -- is held by the store's own
 * properties below, because a behavioural test of it would have to stand in
 * for the shared audit writer, and a seam that lets a caller substitute that
 * writer is exactly what §5.1 does not allow.
 */

const STORE = "lib/trustSafetyActivationStore.ts";
const ROUTE = "app/api/admin/agents/trust-safety/activation/route.ts";

const codeOf = (file) =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join("\n");

test("the first write creates the row and claims no previous mode", () => {
  // No migration seeds the row and §14's order has the operator go straight to
  // `on`, so a first write has to be allowed. Inventing `fromMode: "off"` for
  // it would put a mode in the evidence that was never stored.
  const planned = nextActivationWrite({ current: null, requested: "on" });
  assert.deepEqual(planned, { refusal: null, fromMode: null, toMode: "on", version: 1 });
});

test("the two transitions move the version forward", () => {
  assert.deepEqual(nextActivationWrite({ current: { mode: "off", version: 3 }, requested: "on" }), {
    refusal: null,
    fromMode: "off",
    toMode: "on",
    version: 4,
  });
  assert.deepEqual(nextActivationWrite({ current: { mode: "on", version: 4 }, requested: "off" }), {
    refusal: null,
    fromMode: "on",
    toMode: "off",
    version: 5,
  });
});

test("the same mode again writes nothing", () => {
  // §6 names this case: the common one is a double click, and it must not
  // append an entry that says nothing changed.
  for (const mode of ["off", "on"]) {
    assert.deepEqual(nextActivationWrite({ current: { mode, version: 2 }, requested: mode }), {
      refusal: "not_a_transition",
    });
  }
});

test("a mode outside the two is refused, from either side", () => {
  assert.deepEqual(nextActivationWrite({ current: null, requested: "shadow" }), {
    refusal: "mode_unknown",
  });
  // A stored value outside the two was written around the database CHECK. §6
  // reports that as its own fault rather than letting the next write hide it.
  assert.deepEqual(
    nextActivationWrite({ current: { mode: "paused", version: 1 }, requested: "on" }),
    { refusal: "stored_mode_unknown" },
  );
});

test("every refusal the core can return is in the closed set", () => {
  const seen = new Set();
  for (const current of [null, { mode: "off", version: 1 }, { mode: "zzz", version: 1 }]) {
    for (const requested of ["on", "off", "shadow"]) {
      const { refusal } = nextActivationWrite({ current, requested });
      if (refusal !== null) seen.add(refusal);
    }
  }
  for (const refusal of seen) {
    assert.ok(ACTIVATION_REFUSALS.includes(refusal), `${refusal} is declared`);
  }
});

test("the store writes the config row and one audit entry, in one transaction", () => {
  const code = codeOf(STORE);
  // §5.6 allows exactly these two writes in E3's closure.
  assert.match(code, /withTrustSafetyTransaction\(\{/);
  assert.match(code, /kind: "activation_write"/);
  assert.match(code, /writeAdminAuditLog\(\{/);
  assert.equal((code.match(/writeAdminAuditLog\(/g) ?? []).length, 1, "one append, never two");
  const writes = code.match(/trustSafetyObserverConfig\.(create|update|upsert|delete)\(/g) ?? [];
  assert.deepEqual(writes, ["trustSafetyObserverConfig.create(", "trustSafetyObserverConfig.update("]);
  // An upsert may cost one statement or two depending on the Prisma version,
  // and this kind's budget has no spare statement to find out with.
  assert.doesNotMatch(code, /upsert/);
  // No other table is touched, and the audit table is never written directly.
  assert.doesNotMatch(code, /adminAuditLog\./);
  assert.doesNotMatch(code, /privacyRequest|TrustSafetyObserverRun/);
});

test("the audit append is charged the statements it really sends", () => {
  // Charging it as one would let this transaction send eleven round trips
  // under a budget approved for eight. The writer sends four with an
  // integrity key configured -- the advisory lock, the database clock, the
  // head of the chain, and the insert -- and the store refuses before opening
  // the write when no key is configured, so the four-statement path is the
  // only one it can take.
  const store = codeOf(STORE);
  assert.match(store, /const AUDIT_APPEND_STATEMENTS = 4;/);
  assert.match(store, /AUDIT_APPEND_STATEMENTS,\s*\)/);

  const writer = readFileSync("lib/adminAudit.ts", "utf8");
  const append = writer.slice(writer.indexOf("async function appendAuditChainEntry"));
  const body = append.slice(0, append.indexOf("\nexport ") === -1 ? undefined : append.indexOf("\nexport "));
  const statements =
    (body.match(/client\.\$executeRaw/g) ?? []).length +
    (body.match(/client\.\$queryRaw/g) ?? []).length +
    (body.match(/client\.adminAuditLog\.(findFirst|create)\(/g) ?? []).length;
  assert.equal(statements, 4, `the writer sends ${statements} statements per append`);
});

test("the eight statements of this kind are all accounted for", () => {
  // §12 table B gives the activation write A = 8: the arming statement, the
  // deadline, the read, the write, and the append's four. There is no spare,
  // which is the point -- a ninth is refused rather than silently allowed.
  const bound = TRUST_SAFETY_BOUNDS.get("activation_write");
  assert.equal(bound.statementCeiling, 8);
  assert.equal(2 + 1 + 1 + 4, bound.statementCeiling);
});

test("the integrity key is checked before the transaction opens", () => {
  // §6 in those words. A row whose audit entry cannot be signed is a switch
  // turned on behind a chain the observer's own checks read as broken.
  const code = codeOf(STORE);
  const keyCheck = code.indexOf("adminAuditIntegrityKeysForVerification");
  const transaction = code.indexOf("withTrustSafetyTransaction");
  assert.ok(keyCheck > 0 && transaction > 0);
  assert.ok(keyCheck < transaction, "the key is checked first");
  assert.match(code, /integrity_key_missing/);
});

test("the audit metadata is the three fields §6 fixes", () => {
  const code = codeOf(STORE);
  const metadata = code.match(/metadata: \{[\s\S]*?\}/)[0];
  assert.match(metadata, /fromMode/);
  assert.match(metadata, /toMode/);
  assert.match(metadata, /version/);
  const fields = metadata.match(/\b(\w+):/g) ?? [];
  assert.equal(fields.length, 4, "metadata plus its three fields and nothing more");
  assert.match(code, new RegExp(`action: TRUST_SAFETY_ACTIVATION_ACTION`));
  assert.equal(TRUST_SAFETY_ACTIVATION_ACTION, "trust_safety.observer_activation_changed");
});

test("the route checks who, then step-up, then the body", () => {
  // From the handler, not the file: the import block names the same functions
  // in a different order, and a first run of this test read that instead.
  const whole = codeOf(ROUTE);
  const code = whole.slice(whole.indexOf("export async function POST"));
  const order = [
    "isAdminSession",
    'hasAdminPermission(session, "trust-safety:write")',
    "assertRecentAdminAuthentication",
    "request.text()",
    "bodySchema.safeParse",
    "setTrustSafetyActivation",
  ];
  let last = -1;
  for (const step of order) {
    const at = code.indexOf(step);
    assert.ok(at > last, `${step} comes after the step before it`);
    last = at;
  }
  // A non-administrator learns nothing about what is here.
  assert.match(code, /answer\(request, \{ error: "Not found\." \}, 404\)/);
  assert.match(code, /TRUST_SAFETY_WRITE_REQUIRED[\s\S]*?403/);
  // §6: a refusal is 409 and writes nothing.
  assert.match(code, /answer\(request, \{ error: "Refused\.", code: outcome\.result \}, 409\)/);
  // A form submit is answered with a redirect back to the section carrying the
  // refusal code, because the panel cannot read a JSON body (§5.6: these files
  // may not name `fetch`, so the control is a plain submit).
  assert.match(whole, /status: 303/);
  assert.match(whole, /refused=\$\{encodeURIComponent/);
  assert.match(whole, /application\/x-www-form-urlencoded/);
  // The body is the mode and nothing else. The schema sits above the handler,
  // so it is read from the whole file.
  assert.match(whole, /\.strict\(\)/);
  assert.match(whole, /z\.enum\(TRUST_SAFETY_MODES/);
});

test("a stale step-up answers with the remedy, not a bare refusal", () => {
  // §6: the screen has to be able to draw the reauthentication link
  // docs/ui-contracts/admin-console-ia.md requires, and a toast on its own is
  // called a defect there. The shared `adminApprovalErrorResponse` is not
  // available to these files -- `lib/adminApproval.ts` is not one of the six
  // boundary modules -- so the route answers the code itself, using the
  // predicate the boundary module does export.
  const code = codeOf(ROUTE);
  assert.match(code, /isAdminReauthenticationError\(error\)/);
  assert.match(code, /code: "reauthentication_required"/);
  const remedy = code.indexOf("reauthentication_required");
  const internal = code.indexOf('error: "Internal error."');
  assert.ok(remedy < internal, "the remedy is answered before the generic failure");
});

test("a concurrent activation write is a refusal, not a failure", () => {
  // Two writes that read the same version are settled by the row's own
  // trigger (TS005) and nothing is written. Independent review found that
  // surfacing as a 500, which sends the operator looking for a fault that is
  // not there; it answers 409 `stale` now.
  const code = codeOf(ROUTE);
  assert.match(code, /isActivationConflict\(error\)/);
  assert.match(code, /code: "stale" \}, 409\)/);
  const conflict = code.indexOf("isActivationConflict");
  const internal = code.indexOf('error: "Internal error."');
  assert.ok(conflict < internal, "answered before the generic failure");
});

test("the route builds its own responses and caps its own body", () => {
  // (ㄴ') closes the outside specifiers at eight and `next/server` is not one,
  // and `lib/apiSecurity.ts` is not a boundary module -- so `NextResponse`,
  // `readLimitedJson` and the shared rate limit are all unavailable here. The
  // route therefore has to do these two itself, and a regression that reaches
  // for the familiar helpers would pass §6 while failing §5.6.
  const code = codeOf(ROUTE);
  assert.doesNotMatch(code, /NextResponse|next\/server/);
  assert.doesNotMatch(code, /readLimitedJson|consumeApiRateLimit|apiSecurityResponse/);
  assert.match(code, /new Response\(JSON\.stringify\(body\)/);
  assert.match(code, /"Cache-Control": "no-store"/);
  assert.match(code, /raw\.length > BODY_MAX_BYTES/);
  assert.match(code, /status: 413|, 413\)/);
});
