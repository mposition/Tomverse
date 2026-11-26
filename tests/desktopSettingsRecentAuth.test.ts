import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildDesktopSettingsClaim,
  desktopRecentAuthEnabled,
  readDesktopAuthenticatedAt,
  readLiveDesktopFamilyCreatedAt,
  resolveAccountAuthenticatedAt,
} from "../lib/desktopSettingsSessionCore.ts";
import { resolveAdminSessionAccessState } from "../lib/adminAuthCore.ts";
import { hasRecentAccountAuthentication, hasRecentAdminAuthentication } from "../lib/adminReauthentication.ts";

const createdAt = new Date("2026-11-26T01:00:00.000Z");
const identity = { familyId: "family-1", userId: "user-1", deviceId: "device-1" };

test("the recent sign-in switch is off unless it is exactly true", () => {
  assert.equal(desktopRecentAuthEnabled({}), false);
  for (const value of ["", "1", "TRUE", "True", "yes", " true"]) {
    assert.equal(desktopRecentAuthEnabled({ TOMVERSE_DESKTOP_RECENT_AUTH_ENABLED: value }), false, value);
  }
  assert.equal(desktopRecentAuthEnabled({ TOMVERSE_DESKTOP_RECENT_AUTH_ENABLED: "true" }), true);
});

test("a switched-off settings session carries no authentication time", () => {
  const claim = buildDesktopSettingsClaim({
    familyId: "f", deviceId: "d", tokenId: "t", familyCreatedAt: createdAt, enabled: false,
  });
  assert.deepEqual(claim, { family: "f", device: "d", id: "t" });
  assert.equal("authenticatedAt" in claim, false);
});

test("a switched-on settings session carries the token family creation time", () => {
  const claim = buildDesktopSettingsClaim({
    familyId: "f", deviceId: "d", tokenId: "t", familyCreatedAt: createdAt, enabled: true,
  });
  assert.equal(claim.authenticatedAt, "2026-11-26T01:00:00.000Z");
  assert.deepEqual(
    buildDesktopSettingsClaim({ familyId: "f", deviceId: "d", tokenId: "t", familyCreatedAt: null, enabled: true }),
    { family: "f", device: "d", id: "t" },
  );
  assert.equal(
    buildDesktopSettingsClaim({ familyId: "f", deviceId: "d", tokenId: "t", familyCreatedAt: new Date(Number.NaN), enabled: true })
      .authenticatedAt,
    undefined,
  );
});

test("the claim time is the same for every settings session of one family", () => {
  // The family's createdAt is written at sign-in and a refresh never moves it, so
  // two sessions minted hours apart report the same time.
  const first = buildDesktopSettingsClaim({ familyId: "f", deviceId: "d", tokenId: "t1", familyCreatedAt: createdAt, enabled: true });
  const later = buildDesktopSettingsClaim({ familyId: "f", deviceId: "d", tokenId: "t2", familyCreatedAt: createdAt, enabled: true });
  assert.equal(first.authenticatedAt, later.authenticatedAt);
});

test("the session callback only exposes a canonical time while the switch is on", () => {
  const claim = { authenticatedAt: "2026-11-26T01:00:00.000Z" };
  assert.equal(readDesktopAuthenticatedAt(claim, true), "2026-11-26T01:00:00.000Z");
  assert.equal(readDesktopAuthenticatedAt(claim, false), undefined);
  assert.equal(readDesktopAuthenticatedAt(undefined, true), undefined);
  for (const bad of [undefined, null, 5, "", "nonsense", "2026-11-26", "2026-11-26T01:00:00Z", "2026-13-40T99:00:00.000Z"]) {
    assert.equal(readDesktopAuthenticatedAt({ authenticatedAt: bad }, true), undefined, String(bad));
  }
});

test("the family lookup is bound to the user, the device, a live family and its absolute expiry", async () => {
  const seen: unknown[] = [];
  const now = new Date("2026-11-26T02:00:00.000Z");
  const db = {
    mobileTokenFamily: {
      async findFirst(args: Parameters<Parameters<typeof readLiveDesktopFamilyCreatedAt>[0]["mobileTokenFamily"]["findFirst"]>[0]) {
        seen.push(args);
        return { createdAt };
      },
    },
  };
  assert.deepEqual(await readLiveDesktopFamilyCreatedAt(db, identity, now), createdAt);
  assert.deepEqual(seen, [{
    where: { id: "family-1", userId: "user-1", deviceId: "device-1", revokedAt: null, absoluteExpiresAt: { gt: now } },
    select: { createdAt: true },
  }]);
  const none = { mobileTokenFamily: { findFirst: async () => null } };
  assert.equal(await readLiveDesktopFamilyCreatedAt(none, identity, now), null);
});

test("account actions accept a Desktop sign-in time, the web's time wins when both exist", () => {
  assert.equal(resolveAccountAuthenticatedAt({ desktopAuthenticatedAt: "2026-11-26T01:00:00.000Z" }), "2026-11-26T01:00:00.000Z");
  assert.equal(
    resolveAccountAuthenticatedAt({ authenticatedAt: "2026-11-26T03:00:00.000Z", desktopAuthenticatedAt: "2026-11-26T01:00:00.000Z" }),
    "2026-11-26T03:00:00.000Z",
  );
  assert.equal(resolveAccountAuthenticatedAt({}), undefined);
  assert.equal(resolveAccountAuthenticatedAt(undefined), undefined);
});

const sessionWith = (user: Record<string, unknown>) =>
  ({ user: { id: "user-1", email: "owner@example.com", ...user }, expires: "2099-01-01T00:00:00.000Z" }) as never;

test("a recent Desktop sign-in passes the account step-up but never the administrator one", () => {
  const recent = new Date(Date.now() - 60_000).toISOString();
  const stale = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
  assert.equal(hasRecentAccountAuthentication(sessionWith({ desktopAuthenticatedAt: recent })), true);
  assert.equal(hasRecentAccountAuthentication(sessionWith({ desktopAuthenticatedAt: stale })), false);
  assert.equal(hasRecentAccountAuthentication(sessionWith({})), false);
  // Administrator step-up and console access read `authenticatedAt` only.
  assert.equal(hasRecentAdminAuthentication(sessionWith({ desktopAuthenticatedAt: recent })), false);
  assert.equal(
    resolveAdminSessionAccessState({
      userId: "user-1", email: "owner@example.com", authenticatedAt: undefined,
      adminUserIds: ["user-1"], adminEmails: ["owner@example.com"], sessionMaxAgeMs: 8 * 3_600_000,
    }),
    "reauthentication-required",
  );
});

test("a refresh moves lastRotatedAt and never the family creation time", () => {
  const source = readFileSync(new URL("../lib/mobileAuthService.ts", import.meta.url), "utf8");
  const updates = [...source.matchAll(/mobileTokenFamily\.update(?:Many)?\(\{[\s\S]*?\n\s*\}\);/g)].map((match) => match[0]);
  assert.ok(updates.length >= 2, "expected the rotation and the revocation writes");
  for (const write of updates) assert.doesNotMatch(write, /createdAt/, write);
  const creations = [...source.matchAll(/mobileTokenFamily\.create\(/g)];
  assert.equal(creations.length, 1, "a token family may only be created at sign-in");
});

test("the settings route reads the switch before any family lookup and keeps it default off", () => {
  const route = readFileSync(new URL("../app/api/auth/desktop/settings-session/route.ts", import.meta.url), "utf8");
  assert.match(route, /const recentAuth = desktopRecentAuthEnabled\(\);/);
  assert.ok(route.indexOf("if (recentAuth)") < route.indexOf("readLiveDesktopFamilyCreatedAt("));
  assert.match(route, /enabled: recentAuth/);
});
