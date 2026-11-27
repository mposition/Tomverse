import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { after, before, beforeEach, mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { Session } from "next-auth";
import { resetTestFixture } from "./resetTestFixture";
import { softPasskey } from "./softPasskey";

// Desktop remote control against a real database (docs/ops/desktop-remote-control.md): the PC's report and answer
// pick-up through its own Desktop bearer, the web screen through the account's signed-in session. What this file
// fixes: both switches off answer "not available" and write nothing; one account can never read or answer another
// account's PC; acting needs a recent web sign-in; an answer is recorded once, only for the request the PC reported
// with the same digest, handed to the PC once and never after it expires; reports expire and are deleted, and turning
// the feature off or signing the PC out removes them.

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) => pathToFileURL(resolve(ROOT, relativePath)).href;

const ed25519 = () =>
  generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");

process.env.MOBILE_AUTH_SIGNING_KEYS = `sign-1:${ed25519()}`;
process.env.MOBILE_AUTH_ACTIVE_SIGNING_KEY_ID = "sign-1";
process.env.MOBILE_AUTH_REFRESH_PEPPERS = `pep-1:${randomBytes(32).toString("base64url")}`;
process.env.MOBILE_AUTH_ACTIVE_REFRESH_PEPPER_ID = "pep-1";
process.env.MOBILE_AUTH_TOKEN_ISSUER = "https://tomverse.test";
process.env.MOBILE_AUTH_TOKEN_AUDIENCE = "tomverse-mobile-api";
process.env.ADMIN_AUDIT_INTEGRITY_KEY ||= "desktop-remote-control-audit-test-key";

// The web routes read the cookie session through getServerSession; each test says whose session it is.
let currentSession: Session | null = null;
mock.module("next-auth/next", { namedExports: { getServerSession: async () => currentSession } });

type Route = Record<string, (request: Request) => Promise<Response>>;
let prisma: (typeof import("@/lib/prisma"))["prisma"];
let issueMobileSession: (typeof import("@/lib/mobileAuthService"))["issueMobileSession"];
let purge: (typeof import("@/lib/desktopRemoteControlStore"))["purgeDesktopRemoteControl"];
let sync: Route;
let devices: Route;
let commands: Route;

before(async () => {
  ({ prisma } = (await import(mod("lib/prisma.ts"))) as typeof import("@/lib/prisma"));
  ({ issueMobileSession } = (await import(mod("lib/mobileAuthService.ts"))) as typeof import("@/lib/mobileAuthService"));
  ({ purgeDesktopRemoteControl: purge } = (await import(mod("lib/desktopRemoteControlStore.ts"))) as typeof import("@/lib/desktopRemoteControlStore"));
  sync = (await import(mod("app/api/desktop/remote/sync/route.ts"))) as Route;
  devices = (await import(mod("app/api/desktop/remote/devices/route.ts"))) as Route;
  commands = (await import(mod("app/api/desktop/remote/commands/route.ts"))) as Route;
});

const switchOn = () => {
  process.env.TOMVERSE_DESKTOP_AUTH_ENABLED = "true";
  process.env.TOMVERSE_DESKTOP_REMOTE_CONTROL_ENABLED = "true";
};

const reset = async () => {
  await resetTestFixture(prisma, `
    TRUNCATE TABLE
      "DesktopRemoteCommand", "DesktopRemoteDevice", "DesktopRemotePasskey", "DesktopRemotePasskeyChallenge",
      "MobileAuthEvent", "MobileRefreshRotation", "MobileTokenFamily", "MobileLoginGrant", "MobileDevice",
      "ChatUsageBucket", "UserSettings", "User"
    RESTART IDENTITY CASCADE
  `);
  const { resetMobileSessionSnapshotsForTesting } = await import(mod("lib/mobileSessionAuthorization.ts"));
  resetMobileSessionSnapshotsForTesting();
  currentSession = null;
  switchOn();
  delete process.env.TOMVERSE_DESKTOP_REMOTE_PASSKEY_ENABLED;
};
beforeEach(reset);
after(async () => {
  await reset();
  await prisma.$disconnect();
});

const createUser = (label: string) => prisma.user.create({ data: { email: `${label}-${randomUUID()}@example.test` } });

const desktopFor = async (userId: string, platform: "desktop" | "ios" = "desktop") => {
  const issued = await issueMobileSession({
    request: new Request("https://tomverse.test/api/auth/desktop/exchange", { method: "POST" }),
    userId, platform, deviceLabel: platform === "desktop" ? "Work PC" : "Phone",
  });
  assert.equal(issued.ok, true);
  if (!issued.ok) throw new Error("no session");
  return { token: issued.tokens.accessToken, refreshToken: issued.tokens.refreshToken, deviceId: issued.tokens.deviceId };
};

const webSession = (userId: string, signedInMinutesAgo = 1, extra: Partial<Session["user"]> = {}): Session => ({
  user: { id: userId, email: `${userId}@example.test`, authenticatedAt: new Date(Date.now() - signedInMinutesAgo * 60_000).toISOString(), ...extra },
  expires: new Date(Date.now() + 3_600_000).toISOString(),
});

const TASK = randomUUID();
const APPROVAL = randomUUID();
const DIGEST = "a".repeat(64);
const snapshot = (overrides: { remote?: boolean; approval?: null; digest?: string; approvalId?: string } = {}) => ({
  tasks: [{ key: TASK, kind: "foreground", title: "Fix the login form", status: "approval", progress: ["I will update the form."],
    changes: 1, canStop: true, canFollowUp: false }],
  approval: overrides.approval === null ? null : {
    id: overrides.approvalId ?? APPROVAL, taskKey: TASK, digest: overrides.digest ?? DIGEST, kind: "command", tool: "run_command",
    target: "npm test", files: [], moreFiles: 0, remote: overrides.remote ?? true,
  },
});

// The PC numbers its requests; each helper call takes the next number unless the test names one.
let seq = Date.now();
const syncAs = (token: string, body: object, headers: Record<string, string> = {}) =>
  sync.POST(new Request("https://tomverse.test/api/desktop/remote/sync", {
    method: "POST", body: JSON.stringify({ seq: ++seq, ...body }),
    headers: { "Content-Type": "application/json", Origin: "tomverse://desktop", Authorization: `Bearer ${token}`, ...headers },
  }));

const withdrawAs = (token: string, body: object = {}) =>
  sync.DELETE(new Request("https://tomverse.test/api/desktop/remote/sync", {
    method: "DELETE", body: JSON.stringify({ seq: ++seq, ...body }),
    headers: { "Content-Type": "application/json", Origin: "tomverse://desktop", Authorization: `Bearer ${token}` },
  }));

const listAs = (session: Session | null, headers: Record<string, string> = {}) => {
  currentSession = session;
  return devices.GET(new Request("https://tomverse.test/api/desktop/remote/devices", { headers }));
};

const commandAs = (session: Session | null, body: object, headers: Record<string, string> = {}) => {
  currentSession = session;
  return commands.POST(new Request("https://tomverse.test/api/desktop/remote/commands", {
    method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers },
  }));
};

const answer = (deviceId: string, overrides: Record<string, unknown> = {}) => ({
  kind: "approval", deviceId, taskKey: TASK, approvalId: APPROVAL, digest: DIGEST, decision: "once", ...overrides,
});

test("with either switch off every route answers not available and nothing is stored", async () => {
  const user = await createUser("off");
  const desktop = await desktopFor(user.id);
  for (const [name, value] of [["TOMVERSE_DESKTOP_REMOTE_CONTROL_ENABLED", undefined], ["TOMVERSE_DESKTOP_AUTH_ENABLED", undefined]] as const) {
    switchOn();
    delete process.env[name];
    void value;
    const synced = await syncAs(desktop.token, { snapshot: snapshot(), acks: [] });
    assert.equal(synced.status, 503);
    assert.deepEqual(await synced.json(), { ok: false, code: "NOT_AVAILABLE" });
    assert.equal((await listAs(webSession(user.id))).status, 503);
    assert.equal((await commandAs(webSession(user.id), answer(desktop.deviceId))).status, 503);
  }
  assert.equal(await prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM "DesktopRemoteDevice"`.then((rows) => rows[0]!.n), 0);
});

test("a PC reports through its own Desktop bearer only", async () => {
  const user = await createUser("bearer");
  const desktop = await desktopFor(user.id);
  const phone = await desktopFor(user.id, "ios");
  assert.equal((await syncAs(phone.token, { snapshot: snapshot(), acks: [] })).status, 401);
  assert.equal((await syncAs(desktop.token, { snapshot: snapshot(), acks: [] }, { Origin: "https://tomverse.test" })).status, 403);
  assert.equal((await syncAs(desktop.token, { snapshot: snapshot(), acks: [] }, { cookie: "next-auth.session-token=x" })).status, 403);
  // An unknown field, or a request that names no task, is refused before anything is written.
  assert.equal((await syncAs(desktop.token, { snapshot: { ...snapshot(), extra: 1 }, acks: [] })).status, 400);
  assert.equal((await syncAs(desktop.token, { snapshot: { ...snapshot(), tasks: [] }, acks: [] })).status, 400);
  // A request kind answered at the PC cannot be reported as answerable from another device.
  const git = snapshot();
  git.approval!.kind = "git";
  assert.equal((await syncAs(desktop.token, { snapshot: git, acks: [] })).status, 400);

  const accepted = await syncAs(desktop.token, { snapshot: snapshot(), acks: [] });
  assert.equal(accepted.status, 200, await accepted.clone().text());
  assert.equal(accepted.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await accepted.json(), { ok: true, deviceId: desktop.deviceId, commands: [] });
  // The web routes never take a bearer, Desktop or mobile.
  assert.equal((await listAs(webSession(user.id), { Authorization: `Bearer ${desktop.token}` })).status, 401);
  assert.equal((await listAs(webSession(user.id), { Origin: "tomverse://desktop" })).status, 401);
  assert.equal((await listAs(null)).status, 401);
});

test("one account never reads or answers another account's PC", async () => {
  const owner = await createUser("owner");
  const stranger = await createUser("stranger");
  const ownerPc = await desktopFor(owner.id);
  const strangerPc = await desktopFor(stranger.id);
  assert.equal((await syncAs(ownerPc.token, { snapshot: snapshot(), acks: [] })).status, 200);
  assert.equal((await syncAs(strangerPc.token, { snapshot: snapshot({ approval: null }), acks: [] })).status, 200);

  const ownerView = await (await listAs(webSession(owner.id))).json();
  assert.deepEqual(ownerView.devices.map((device: { deviceId: string }) => device.deviceId), [ownerPc.deviceId]);
  assert.equal(ownerView.devices[0].label, "Work PC");
  assert.equal(ownerView.devices[0].snapshot.approval.id, APPROVAL);
  const strangerView = await (await listAs(webSession(stranger.id))).json();
  assert.deepEqual(strangerView.devices.map((device: { deviceId: string }) => device.deviceId), [strangerPc.deviceId]);

  // The stranger names the owner's PC and the owner's request id and digest, exactly as reported.
  for (const body of [answer(ownerPc.deviceId), { kind: "stop", deviceId: ownerPc.deviceId, taskKey: TASK }]) {
    const refused = await commandAs(webSession(stranger.id), body);
    assert.equal(refused.status, 404);
    assert.deepEqual(await refused.json(), { ok: false, code: "DEVICE_NOT_FOUND" });
  }
  // And the owner cannot reach the stranger's PC.
  assert.equal((await commandAs(webSession(owner.id), { kind: "stop", deviceId: strangerPc.deviceId, taskKey: TASK })).status, 404);
  const rows = await prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM "DesktopRemoteCommand"`;
  assert.equal(rows[0]!.n, 0);
  // Nothing the stranger sent reaches the owner's PC.
  assert.deepEqual((await (await syncAs(ownerPc.token, { snapshot: snapshot(), acks: [] })).json()).commands, []);
});

test("acting needs a recent web sign-in; an old session or a Desktop's own sign-in time may only look", async () => {
  const user = await createUser("recent");
  const pc = await desktopFor(user.id);
  await syncAs(pc.token, { snapshot: snapshot(), acks: [] });
  const stale = webSession(user.id, 6 * 60);
  const staleView = await (await listAs(stale)).json();
  assert.equal(staleView.canAct, false);
  assert.equal(staleView.devices.length, 1);
  const refused = await commandAs(stale, answer(pc.deviceId));
  assert.equal(refused.status, 428);
  assert.deepEqual(await refused.json(), { ok: false, code: "ACCOUNT_REAUTHENTICATION_REQUIRED" });
  // A Desktop settings session carries the Desktop's sign-in time and no web one.
  const desktopSession = webSession(user.id, 0, { authenticatedAt: undefined, desktopAuthenticatedAt: new Date().toISOString() });
  assert.equal((await commandAs(desktopSession, answer(pc.deviceId))).status, 428);
  assert.equal((await (await listAs(webSession(user.id))).json()).canAct, true);
  assert.equal((await prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM "DesktopRemoteCommand"`)[0]!.n, 0);
});

test("an answer is recorded once, only for the reported request and digest, and audited", async () => {
  const user = await createUser("answer");
  const pc = await desktopFor(user.id);
  await syncAs(pc.token, { snapshot: snapshot(), acks: [] });
  const session = webSession(user.id);

  for (const [body, code] of [
    [answer(pc.deviceId, { approvalId: randomUUID() }), "APPROVAL_NOT_OPEN"],
    [answer(pc.deviceId, { digest: "b".repeat(64) }), "APPROVAL_CHANGED"],
    [answer(pc.deviceId, { taskKey: randomUUID() }), "APPROVAL_NOT_OPEN"],
    [{ kind: "follow_up", deviceId: pc.deviceId, taskKey: TASK, text: "Also run lint." }, "FOLLOW_UP_UNAVAILABLE"],
  ] as const) {
    const refused = await commandAs(session, body);
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), { ok: false, code });
  }
  // "Allow for this run" is not an answer another device can give.
  assert.equal((await commandAs(session, answer(pc.deviceId, { decision: "run" }))).status, 400);

  const accepted = await commandAs(session, answer(pc.deviceId));
  assert.equal(accepted.status, 201, await accepted.clone().text());
  const { id } = await accepted.json();
  const again = await commandAs(session, answer(pc.deviceId, { decision: "deny" }));
  assert.equal(again.status, 409);
  assert.deepEqual(await again.json(), { ok: false, code: "ALREADY_ANSWERED" });

  const audit = await prisma.adminAuditLog.findMany({ where: { targetType: "DesktopRemoteCommand", targetId: id } });
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.action, "desktop_remote.approval_answered");
  assert.equal(audit[0]!.actorUserId, user.id);
  assert.ok(audit[0]!.entryHash);
  assert.deepEqual(audit[0]!.metadata, { deviceId: pc.deviceId, taskKey: TASK, approvalId: APPROVAL, decision: "once", digest: DIGEST, approvalKind: "command" });

  // Reported as answerable only at the PC: refused, and never stored.
  const other = await createUser("pc-only");
  const otherPc = await desktopFor(other.id);
  await syncAs(otherPc.token, { snapshot: snapshot({ remote: false }), acks: [] });
  const pcOnly = await commandAs(webSession(other.id), answer(otherPc.deviceId));
  assert.equal(pcOnly.status, 409);
  assert.deepEqual(await pcOnly.json(), { ok: false, code: "APPROVAL_PC_ONLY" });
});

test("the PC receives an answer once, reports what it did, and never receives one that expired", async () => {
  const user = await createUser("delivery");
  const pc = await desktopFor(user.id);
  await syncAs(pc.token, { snapshot: snapshot(), acks: [] });
  const session = webSession(user.id);
  const { id } = await (await commandAs(session, answer(pc.deviceId))).json();

  const first = await (await syncAs(pc.token, { snapshot: snapshot(), acks: [] })).json();
  assert.equal(first.commands.length, 1);
  assert.equal(first.commands[0].id, id);
  assert.equal(first.commands[0].kind, "approval");
  assert.equal(first.commands[0].approvalId, APPROVAL);
  assert.equal(first.commands[0].digest, DIGEST);
  assert.equal(first.commands[0].decision, "once");
  assert.equal(first.commands[0].deviceId, pc.deviceId);
  assert.ok(first.commands[0].ageMs >= 0 && first.commands[0].ageMs < 60_000);
  // A replayed sync gets nothing more.
  assert.deepEqual((await (await syncAs(pc.token, { snapshot: snapshot({ approval: null }), acks: [] })).json()).commands, []);

  await syncAs(pc.token, { snapshot: snapshot({ approval: null }), acks: [{ id, result: "applied" }] });
  const view = await (await listAs(session)).json();
  assert.equal(view.devices[0].commands[0].state, "applied");

  // A stop the PC never picked up in time is never handed to it.
  const stop = await (await commandAs(session, { kind: "stop", deviceId: pc.deviceId, taskKey: TASK })).json();
  await prisma.$executeRaw`UPDATE "DesktopRemoteCommand" SET "expiresAt" = now() - interval '1 second' WHERE "id" = ${stop.id}`;
  assert.deepEqual((await (await syncAs(pc.token, { snapshot: snapshot({ approval: null }), acks: [] })).json()).commands, []);
  const expired = await (await listAs(session)).json();
  assert.equal(expired.devices[0].commands.find((row: { id: string }) => row.id === stop.id).state, "expired");
  // An acknowledgement for an answer the PC was never given is ignored.
  await syncAs(pc.token, { snapshot: snapshot({ approval: null }), acks: [{ id: stop.id, result: "applied" }] });
  const unchanged = await prisma.$queryRaw<Array<{ result: string | null }>>`SELECT "result" FROM "DesktopRemoteCommand" WHERE "id" = ${stop.id}`;
  assert.equal(unchanged[0]!.result, null);
});

test("reports expire and are deleted; turning off and signing the PC out remove them", async () => {
  const user = await createUser("ttl");
  const pc = await desktopFor(user.id);
  const session = webSession(user.id);
  await syncAs(pc.token, { snapshot: snapshot(), acks: [] });
  await commandAs(session, answer(pc.deviceId));
  const count = async () => (await prisma.$queryRaw<Array<{ devices: number; commands: number }>>`
    SELECT (SELECT count(*)::int FROM "DesktopRemoteDevice") AS devices, (SELECT count(*)::int FROM "DesktopRemoteCommand") AS commands
  `)[0]!;

  // Past its expiry a report is no longer shown, and nothing can be sent to it.
  await prisma.$executeRaw`UPDATE "DesktopRemoteDevice" SET "expiresAt" = now() - interval '1 second'`;
  assert.deepEqual((await (await listAs(session)).json()).devices, []);
  assert.equal((await commandAs(session, answer(pc.deviceId, { decision: "deny" }))).status, 404);
  // This one is kept, hidden, with its answer: the PC went away with the request still open. Neither the screen nor
  // maintenance deletes it, however old the answer is, so a second answer is still refused when the PC comes back
  // with the same request, and the screen shows the first one.
  assert.deepEqual(await count(), { devices: 1, commands: 1 });
  await prisma.$executeRaw`UPDATE "DesktopRemoteCommand" SET "createdAt" = now() - interval '16 minutes'`;
  assert.deepEqual(await purge(), { commands: 0, devices: 0 });
  await syncAs(pc.token, { snapshot: snapshot(), acks: [] });
  assert.deepEqual(await count(), { devices: 1, commands: 1 });
  const second = await commandAs(session, answer(pc.deviceId, { decision: "deny" }));
  assert.deepEqual(await second.json(), { ok: false, code: "ALREADY_ANSWERED" });
  assert.equal((await (await listAs(session)).json()).devices[0].commands.length, 1);

  // Once the PC reports the request closed, maintenance deletes the answer at its retention, and the report at its
  // expiry, with nobody reading.
  await prisma.$executeRaw`UPDATE "DesktopRemoteDevice" SET "snapshot" = jsonb_set("snapshot", '{approval}', 'null'::jsonb)`;
  assert.deepEqual(await purge(), { commands: 1, devices: 0 });
  await prisma.$executeRaw`UPDATE "DesktopRemoteDevice" SET "expiresAt" = now() - interval '1 second'`;
  assert.deepEqual(await purge(), { commands: 0, devices: 1 });
  // An expired report with no answered request is deleted by the screen's own read as well.
  await syncAs(pc.token, { snapshot: snapshot(), acks: [] });
  await prisma.$executeRaw`UPDATE "DesktopRemoteDevice" SET "expiresAt" = now() - interval '1 second'`;
  assert.deepEqual((await (await listAs(session)).json()).devices, []);
  assert.deepEqual(await count(), { devices: 0, commands: 0 });

  // Turning remote control off on the PC removes its report and the answers waiting for it. What stays for two minutes
  // is an empty, hidden marker with the number of that request: a sync the PC sent before it, which arrives after it, is
  // refused and puts nothing back.
  const sentEarlier = ++seq;
  await syncAs(pc.token, { snapshot: snapshot(), acks: [] });
  // A report that is not newer than the last one taken changes nothing, also while remote control is on.
  const outOfOrder = await syncAs(pc.token, { seq: sentEarlier, snapshot: snapshot({ approval: null }), acks: [] });
  assert.equal(outOfOrder.status, 409);
  assert.equal((await (await listAs(session)).json()).devices[0].snapshot.approval.id, APPROVAL);
  await commandAs(session, answer(pc.deviceId, { approvalId: APPROVAL }));
  const withdrawn = await withdrawAs(pc.token);
  assert.equal(withdrawn.status, 204);
  const withdrawnSeq = seq;
  assert.deepEqual(await count(), { devices: 1, commands: 0 });
  assert.deepEqual((await (await listAs(session)).json()).devices, []);
  const late = await syncAs(pc.token, { seq: withdrawnSeq - 1, snapshot: snapshot(), acks: [] });
  assert.equal(late.status, 409);
  const refusal = await late.json();
  assert.equal(refusal.code, "STALE_SYNC");
  assert.equal(refusal.seq, withdrawnSeq);
  assert.deepEqual((await (await listAs(session)).json()).devices, []);
  assert.equal((await commandAs(session, answer(pc.deviceId))).status, 404);
  // The marker outlives the screen's read and maintenance while it is fresh, and goes after two minutes.
  assert.deepEqual(await purge(), { commands: 0, devices: 0 });
  await prisma.$executeRaw`UPDATE "DesktopRemoteDevice" SET "withdrawnAt" = now() - interval '3 minutes'`;
  assert.deepEqual(await purge(), { commands: 0, devices: 1 });
  // A withdrawal without a number is refused and changes nothing.
  const unnumbered = await sync.DELETE(new Request("https://tomverse.test/api/desktop/remote/sync", {
    method: "DELETE", headers: { Origin: "tomverse://desktop", Authorization: `Bearer ${pc.token}` },
  }));
  assert.equal(unnumbered.status, 400);

  // Off and on again: the withdrawal of the first arrives after a sync of the second. It was sent earlier, so it changes
  // nothing: the live report and the answer waiting for it stay.
  const earlierOff = ++seq;
  await syncAs(pc.token, { snapshot: snapshot(), acks: [] });
  assert.equal((await commandAs(session, answer(pc.deviceId))).status, 201);
  const lateOff = await withdrawAs(pc.token, { seq: earlierOff });
  assert.equal(lateOff.status, 409);
  assert.equal((await lateOff.json()).code, "STALE_SYNC");
  assert.deepEqual(await count(), { devices: 1, commands: 1 });
  assert.equal((await (await listAs(session)).json()).devices.length, 1);
  // An answer recorded while the PC turns remote control off never outlives the withdrawal: whichever of the two takes
  // the row first, no answer is left for a PC that is turned on again.
  const racing = await Promise.all([
    commandAs(session, { kind: "stop", deviceId: pc.deviceId, taskKey: TASK }),
    withdrawAs(pc.token),
  ]);
  assert.equal(racing[1].status, 204);
  assert.ok([201, 404].includes(racing[0].status), String(racing[0].status));
  assert.deepEqual(await count(), { devices: 1, commands: 0 });

  // Signing the PC out revokes its token family: the report is no longer shown and is deleted, and nothing can be sent to it.
  await syncAs(pc.token, { snapshot: snapshot(), acks: [] });
  await commandAs(session, answer(pc.deviceId));
  const { logoutMobileSession } = (await import(mod("lib/mobileAuthService.ts"))) as typeof import("@/lib/mobileAuthService");
  await logoutMobileSession({ request: new Request("https://tomverse.test/api/auth/desktop/logout", { method: "POST" }), refreshToken: pc.refreshToken, client: "desktop" });
  assert.equal((await commandAs(session, answer(pc.deviceId, { decision: "deny" }))).status, 404);
  // The expired report maintenance keeps for an answered request goes too once the sign-in has ended.
  await prisma.$executeRaw`UPDATE "DesktopRemoteDevice" SET "expiresAt" = now() - interval '1 second'`;
  assert.deepEqual(await purge(), { commands: 0, devices: 1 });
  assert.deepEqual((await (await listAs(session)).json()).devices, []);
  assert.deepEqual(await count(), { devices: 0, commands: 0 });

  // Deleting the account takes everything with it.
  const other = await desktopFor(user.id);
  await syncAs(other.token, { snapshot: snapshot(), acks: [] });
  await prisma.user.delete({ where: { id: user.id } });
  assert.deepEqual(await count(), { devices: 0, commands: 0 });
});

// ── Passkey confirmation (lib/desktopRemotePasskeyStore.ts) ───────────────────────────────────────────────────────

const SITE = "https://tomverse.test";
// What a route answers is read by name in these tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

test("passkeys: nothing is offered while the passkey switch is off, and a deployment's own origin is required", async () => {
  const user = await createUser("pk-off");
  const passkeyRoute = (await import(mod("app/api/desktop/remote/passkey/route.ts"))) as Route;
  const call = (session: Session | null, body: object, headers: Record<string, string> = { Origin: SITE }) => {
    currentSession = session;
    return passkeyRoute.POST!(new Request(`${SITE}/api/desktop/remote/passkey`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers } }));
  };
  delete process.env.TOMVERSE_DESKTOP_REMOTE_PASSKEY_ENABLED;
  assert.equal((await call(webSession(user.id), { action: "options-register" })).status, 503);
  assert.deepEqual((await (await listAs(webSession(user.id))).json()).passkey, { enabled: false, passkeys: [] });
  process.env.TOMVERSE_DESKTOP_REMOTE_PASSKEY_ENABLED = "true";
  process.env.NEXTAUTH_URL = SITE;
  assert.deepEqual((await (await listAs(webSession(user.id))).json()).passkey, { enabled: true, passkeys: [] });
  // Browser session only, signed in recently, and from this deployment's own origin.
  assert.equal((await call(null, { action: "options-register" })).status, 401);
  assert.equal((await call(webSession(user.id, 6 * 60), { action: "options-register" })).status, 428);
  assert.equal((await call(webSession(user.id), { action: "options-register" }, {})).status, 403);
  assert.equal((await call(webSession(user.id), { action: "options-register" }, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await call(webSession(user.id), { action: "options-register" })).status, 200);
});

test("passkeys: a registered passkey confirms allow once and follow-ups, each bound to its own command", async () => {
  process.env.TOMVERSE_DESKTOP_REMOTE_PASSKEY_ENABLED = "true";
  process.env.NEXTAUTH_URL = SITE;
  const passkeyRoute = (await import(mod("app/api/desktop/remote/passkey/route.ts"))) as Route;
  const user = await createUser("pk-flow");
  const pc = await desktopFor(user.id);
  const session = webSession(user.id);
  const call = async (body: object, headers: Record<string, string> = { Origin: SITE }) => {
    currentSession = session;
    const response = await passkeyRoute.POST!(new Request(`${SITE}/api/desktop/remote/passkey`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers } }));
    return { status: response.status, body: await response.json() as Json };
  };
  const phone = softPasskey(SITE);

  // Register the first passkey.
  const asked = await call({ action: "options-register" });
  assert.equal(asked.status, 200);
  assert.equal(asked.body.confirm, undefined);
  assert.equal(asked.body.publicKey.rp.id, "tomverse.test");
  assert.equal(asked.body.publicKey.authenticatorSelection.userVerification, "required");
  const made = phone.create(asked.body.publicKey);
  assert.equal((await call({ action: "register", challengeId: asked.body.challengeId, label: "My phone", ...made })).status, 201);
  // A challenge is used once.
  assert.equal((await call({ action: "register", challengeId: asked.body.challengeId, label: "Again", ...made })).status, 409);
  const registered = await prisma.adminAuditLog.findMany({ where: { action: "desktop_remote.passkey_registered", actorUserId: user.id } });
  assert.equal(registered.length, 1);
  assert.equal(JSON.stringify(registered[0]!.metadata).includes(made.credentialId), false);
  const listed = (await (await listAs(session)).json()).passkey;
  assert.equal(listed.passkeys.length, 1);
  assert.equal(listed.passkeys[0].label, "My phone");
  assert.equal(JSON.stringify(listed).includes("publicKey"), false);

  // "Allow once" now needs the passkey; deny and stop do not.
  const approvalOf = (id: string) => ({ ...snapshot(), approval: { ...snapshot().approval!, id } });
  const first = randomUUID();
  await syncAs(pc.token, { snapshot: approvalOf(first), acks: [] });
  const once = (id: string, extra: Record<string, unknown> = {}) => answer(pc.deviceId, { approvalId: id, ...extra });
  const send = async (body: object) => {
    currentSession = session;
    const response = await commands.POST(new Request(`${SITE}/api/desktop/remote/commands`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", Origin: SITE } }));
    return { status: response.status, body: await response.json() as Json };
  };
  assert.deepEqual((await send(once(first))).body, { ok: false, code: "PASSKEY_REQUIRED" });
  const confirm = async (command: Record<string, unknown>, over: { flags?: number; origin?: string } = {}) => {
    const options = await call({ action: "options-command", command });
    assert.equal(options.status, 200, JSON.stringify(options.body));
    assert.deepEqual(options.body.publicKey.allowCredentials.map((entry: { id: string }) => entry.id), [phone.credentialId]);
    return { challengeId: options.body.challengeId, ...phone.get(options.body.publicKey, over) };
  };
  // An assertion without user verification, or from another origin, is refused.
  assert.equal((await send({ ...once(first), passkey: await confirm(once(first), { flags: 0x01 }) })).status, 403);
  assert.equal((await send({ ...once(first), passkey: await confirm(once(first), { origin: "https://evil.example" }) })).status, 403);
  // An assertion made for one command does not confirm another request.
  const forFirst = await confirm(once(first));
  const second = randomUUID();
  assert.equal((await send({ ...once(second), passkey: forFirst })).status, 403);
  // The right one is accepted once, and its challenge cannot be replayed.
  const proof = await confirm(once(first));
  const accepted = await send({ ...once(first), passkey: proof });
  assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
  const audit = await prisma.adminAuditLog.findFirst({ where: { targetId: accepted.body.id } });
  assert.equal((audit!.metadata as Record<string, unknown>).passkeyId, listed.passkeys[0].id);
  assert.equal((await send({ ...once(first), passkey: proof })).status, 403);

  // Deny and stop reduce what happens: no passkey, and the server issues none for them.
  await syncAs(pc.token, { snapshot: approvalOf(second), acks: [] });
  assert.equal((await call({ action: "options-command", command: once(second, { decision: "deny" }) })).status, 403);
  assert.equal((await send(once(second, { decision: "deny" }))).status, 201);
  assert.equal((await send({ kind: "stop", deviceId: pc.deviceId, taskKey: TASK })).status, 201);

  // A follow-up is bound to its text.
  await syncAs(pc.token, { snapshot: { ...snapshot({ approval: null }), tasks: [{ ...snapshot().tasks[0]!, canFollowUp: true }] }, acks: [] });
  const follow = { kind: "follow_up", deviceId: pc.deviceId, taskKey: TASK, text: "Run the linter too." };
  assert.deepEqual((await send(follow)).body, { ok: false, code: "PASSKEY_REQUIRED" });
  const forText = await confirm(follow);
  assert.equal((await send({ ...follow, text: "Delete everything.", passkey: forText })).status, 403);
  assert.equal((await send({ ...follow, passkey: await confirm(follow) })).status, 201);

  // The passkey switch off again: the account is asked for none.
  delete process.env.TOMVERSE_DESKTOP_REMOTE_PASSKEY_ENABLED;
  const third = randomUUID();
  await syncAs(pc.token, { snapshot: approvalOf(third), acks: [] });
  assert.equal((await send(once(third))).status, 201);
});

test("passkeys: another is added only with an existing one, removal needs one, and an account holds five", async () => {
  process.env.TOMVERSE_DESKTOP_REMOTE_PASSKEY_ENABLED = "true";
  process.env.NEXTAUTH_URL = SITE;
  const passkeyRoute = (await import(mod("app/api/desktop/remote/passkey/route.ts"))) as Route;
  const user = await createUser("pk-more");
  const stranger = await createUser("pk-stranger");
  const session = webSession(user.id);
  const call = async (body: object, as: Session = session) => {
    currentSession = as;
    const response = await passkeyRoute.POST!(new Request(`${SITE}/api/desktop/remote/passkey`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", Origin: SITE } }));
    return { status: response.status, body: await response.json() as Json };
  };
  const add = async (device: ReturnType<typeof softPasskey>, label: string, withExisting?: ReturnType<typeof softPasskey>) => {
    const asked = await call({ action: "options-register" });
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    const made = device.create(asked.body.publicKey);
    const passkey = withExisting && asked.body.confirm ? { challengeId: asked.body.confirm.challengeId, ...withExisting.get(asked.body.confirm.publicKey) } : undefined;
    return call({ action: "register", challengeId: asked.body.challengeId, label, ...made, ...(passkey ? { passkey } : {}) });
  };
  const phone = softPasskey(SITE);
  const laptop = softPasskey(SITE);
  assert.equal((await add(phone, "Phone")).status, 201);
  // A session on its own cannot add a passkey to an account that has one.
  const alone = await add(laptop, "Attacker key");
  assert.equal(alone.status, 428);
  assert.equal(alone.body.code, "PASSKEY_CONFIRMATION_REQUIRED");
  assert.equal((await add(laptop, "Laptop", phone)).status, 201);
  // The same authenticator is not registered twice.
  assert.equal((await add(laptop, "Laptop again", phone)).status, 409);
  const mine = (await (await listAs(session)).json()).passkey.passkeys as Array<{ id: string; label: string }>;
  assert.deepEqual(mine.map((entry) => entry.label), ["Phone", "Laptop"]);

  // Another account sees none of them and cannot remove them.
  assert.deepEqual((await (await listAs(webSession(stranger.id))).json()).passkey.passkeys, []);
  assert.equal((await call({ action: "options-remove", passkeyId: mine[0]!.id }, webSession(stranger.id))).status, 409);

  // Removal needs an assertion made for that removal.
  const options = await call({ action: "options-remove", passkeyId: mine[1]!.id });
  const assertion = { challengeId: options.body.challengeId, ...laptop.get(options.body.publicKey) };
  const wrong = await call({ action: "remove", passkeyId: mine[0]!.id, passkey: assertion });
  assert.equal(wrong.status, 409);
  assert.equal(wrong.body.code, "PASSKEY_CHALLENGE");
  const again = await call({ action: "options-remove", passkeyId: mine[1]!.id });
  const removed = await call({ action: "remove", passkeyId: mine[1]!.id, passkey: { challengeId: again.body.challengeId, ...laptop.get(again.body.publicKey) } });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal((await prisma.adminAuditLog.count({ where: { action: "desktop_remote.passkey_removed", actorUserId: user.id } })), 1);
  assert.deepEqual(((await (await listAs(session)).json()).passkey.passkeys as Array<{ label: string }>).map((entry) => entry.label), ["Phone"]);

  // Five at most. (The route allows a person twenty passkey requests a minute; this test makes more.)
  await prisma.$executeRaw`DELETE FROM "ChatUsageBucket"`;
  for (let index = 0; index < 4; index += 1) assert.equal((await add(softPasskey(SITE), `Key ${index}`, phone)).status, 201);
  const sixth = await call({ action: "options-register" });
  assert.equal(sixth.status, 409);
  assert.equal(sixth.body.code, "PASSKEY_LIMIT");
  // Deleting the account removes the passkeys and their challenges.
  await prisma.user.delete({ where: { id: user.id } });
  assert.equal(await prisma.desktopRemotePasskey.count(), 0);
  assert.equal(await prisma.desktopRemotePasskeyChallenge.count(), 0);
});

test("passkeys: challenges live two minutes and maintenance sweeps the expired", async () => {
  process.env.TOMVERSE_DESKTOP_REMOTE_PASSKEY_ENABLED = "true";
  process.env.NEXTAUTH_URL = SITE;
  const passkeyRoute = (await import(mod("app/api/desktop/remote/passkey/route.ts"))) as Route;
  const { purgeDesktopRemotePasskeyChallenges } = (await import(mod("lib/desktopRemotePasskeyStore.ts"))) as typeof import("@/lib/desktopRemotePasskeyStore");
  const user = await createUser("pk-ttl");
  currentSession = webSession(user.id);
  const asked = await passkeyRoute.POST!(new Request(`${SITE}/api/desktop/remote/passkey`, { method: "POST", body: JSON.stringify({ action: "options-register" }), headers: { "Content-Type": "application/json", Origin: SITE } }));
  const { challengeId, publicKey } = await asked.json();
  await prisma.$executeRaw`UPDATE "DesktopRemotePasskeyChallenge" SET "expiresAt" = now() - interval '1 second'`;
  const late = await passkeyRoute.POST!(new Request(`${SITE}/api/desktop/remote/passkey`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: SITE },
    body: JSON.stringify({ action: "register", challengeId, label: "Late", ...softPasskey(SITE).create(publicKey) }),
  }));
  assert.equal(late.status, 409);
  await purgeDesktopRemotePasskeyChallenges();
  assert.equal(await prisma.desktopRemotePasskeyChallenge.count(), 0);
});
