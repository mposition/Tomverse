import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { after, before, beforeEach, mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { Session } from "next-auth";
import { resetTestFixture } from "./resetTestFixture";

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
      "DesktopRemoteCommand", "DesktopRemoteDevice",
      "MobileAuthEvent", "MobileRefreshRotation", "MobileTokenFamily", "MobileLoginGrant", "MobileDevice",
      "ChatUsageBucket", "UserSettings", "User"
    RESTART IDENTITY CASCADE
  `);
  const { resetMobileSessionSnapshotsForTesting } = await import(mod("lib/mobileSessionAuthorization.ts"));
  resetMobileSessionSnapshotsForTesting();
  currentSession = null;
  switchOn();
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

const syncAs = (token: string, body: object, headers: Record<string, string> = {}) =>
  sync.POST(new Request("https://tomverse.test/api/desktop/remote/sync", {
    method: "POST", body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", Origin: "tomverse://desktop", Authorization: `Bearer ${token}`, ...headers },
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

  // Turning remote control off on the PC deletes its report and the answers waiting for it.
  await syncAs(pc.token, { snapshot: snapshot(), acks: [] });
  await commandAs(session, answer(pc.deviceId, { approvalId: APPROVAL }));
  const withdrawn = await sync.DELETE(new Request("https://tomverse.test/api/desktop/remote/sync", {
    method: "DELETE", headers: { Origin: "tomverse://desktop", Authorization: `Bearer ${pc.token}` },
  }));
  assert.equal(withdrawn.status, 204);
  assert.deepEqual(await count(), { devices: 0, commands: 0 });

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
