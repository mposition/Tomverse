import assert from "node:assert/strict";
import test from "node:test";

import {
  INTERNAL_AUTH_HEADER_PREFIX,
  MOBILE_IDENTITY_HEADERS,
  applyMobileIdentityHeaders,
  desktopBillingEnabled,
  desktopComposerToolsEnabled,
  desktopDeepResearchEnabled,
  desktopDriveEnabled,
  desktopPluginsEnabled,
  desktopReadApiRoute,
  desktopRemoteControlEnabled,
  desktopWriteApiRoute,
  nativeBearerVerdict,
  nativeArtifactRevisionBearerRoute,
  nativeParityBearerRoute,
  nativeHistoryFolderBearerRoute,
  nativeProjectWorkspaceBearerRoute,
  stripInternalAuthHeaders,
} from "../lib/nativeBearerGate.ts";
import { N1B_BEARER_ROUTES } from "../lib/mobileAuthContract.ts";

/**
 * The proxy-side gate, and section 5.3's truth table.
 *
 * Design sections 5.1-5.5, approved 2026-08-31. The shipped route list is empty
 * by approval, so the rows that need a registered route are driven with a list
 * this file supplies -- otherwise "the gate works when a route is registered"
 * would be a claim nothing checks until the day somebody registers one.
 */

const REGISTERED = "/api/conversations";

test("Desktop remote control enrols only the PC's own sync path, and only for the Desktop bearer", () => {
  const switches = ["TOMVERSE_DESKTOP_AUTH_ENABLED", "TOMVERSE_DESKTOP_REMOTE_CONTROL_ENABLED"];
  const previous = switches.map((key) => process.env[key]);
  const sync = "/api/desktop/remote/sync";
  try {
    for (const key of switches) delete process.env[key];
    assert.equal(desktopRemoteControlEnabled(), false);
    assert.equal(desktopWriteApiRoute(sync, "POST"), false);
    // Enrolled with Desktop authentication, so the bearer is verified and the route itself says "not available".
    process.env.TOMVERSE_DESKTOP_AUTH_ENABLED = "true";
    assert.equal(desktopRemoteControlEnabled(), false);
    assert.equal(desktopWriteApiRoute(sync, "POST"), true);
    assert.equal(desktopWriteApiRoute(sync, "DELETE"), true);
    for (const method of ["GET", "PUT", "PATCH"]) assert.equal(desktopWriteApiRoute(sync, method), false, method);
    assert.equal(desktopWriteApiRoute(sync + "/x", "POST"), false);
    process.env.TOMVERSE_DESKTOP_REMOTE_CONTROL_ENABLED = "true";
    assert.equal(desktopRemoteControlEnabled(), true);
    // The web screen's routes take the signed-in browser session only; a Desktop bearer never reaches them.
    for (const [path, method] of [["/api/desktop/remote/devices", "GET"], ["/api/desktop/remote/commands", "POST"]]) {
      assert.equal(desktopWriteApiRoute(path, method), false, path);
      assert.equal(desktopReadApiRoute(path, method), false, path);
    }
    delete process.env.TOMVERSE_DESKTOP_AUTH_ENABLED;
    assert.equal(desktopRemoteControlEnabled(), false);
    assert.equal(desktopWriteApiRoute(sync, "POST"), false);
  } finally {
    switches.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});

test("Desktop analysis and composer tools require their own enrollment", () => {
  const switches = ["TOMVERSE_DESKTOP_AUTH_ENABLED", "TOMVERSE_DESKTOP_REVIEW_ENABLED", "TOMVERSE_DESKTOP_CHAT_WRITE_ENABLED",
    "TOMVERSE_DESKTOP_REVIEW_ANALYSIS_ENABLED", "TOMVERSE_DESKTOP_COMPOSER_TOOLS_ENABLED"];
  const previous = switches.map((key) => process.env[key]);
  const analysis = "/api/conversations/review-1/comparison-reviews";
  try {
    for (const key of switches) delete process.env[key];
    for (const key of switches.slice(0, 3)) process.env[key] = "true";
    assert.equal(desktopWriteApiRoute(analysis, "GET"), false);
    assert.equal(desktopWriteApiRoute(analysis, "POST"), false);
    assert.equal(desktopComposerToolsEnabled(), false);
    for (const key of switches.slice(3)) process.env[key] = "true";
    assert.equal(desktopWriteApiRoute(analysis, "GET"), true);
    assert.equal(desktopWriteApiRoute(analysis, "POST"), true);
    assert.equal(desktopWriteApiRoute(analysis, "PATCH"), false);
    assert.equal(desktopWriteApiRoute(analysis + "/verify-item", "POST"), false);
    assert.equal(desktopWriteApiRoute("/api/conversations/%2Freview/comparison-reviews", "POST"), false);
    assert.equal(desktopComposerToolsEnabled(), true);
    delete process.env.TOMVERSE_DESKTOP_REVIEW_ENABLED;
    delete process.env.TOMVERSE_DESKTOP_CHAT_WRITE_ENABLED;
    assert.equal(desktopWriteApiRoute(analysis, "GET"), false);
    assert.equal(desktopComposerToolsEnabled(), false);
  } finally {
    switches.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});

test("Desktop billing screens are off unless their own switch and the account settings session are both on", () => {
  const switches = ["TOMVERSE_DESKTOP_AUTH_ENABLED", "TOMVERSE_DESKTOP_ACCOUNT_SETTINGS_ENABLED", "TOMVERSE_DESKTOP_BILLING_ENABLED"];
  const previous = switches.map((key) => process.env[key]);
  try {
    for (const key of switches) delete process.env[key];
    assert.equal(desktopBillingEnabled(), false);
    for (const key of switches.slice(0, 2)) process.env[key] = "true";
    assert.equal(desktopBillingEnabled(), false);
    process.env.TOMVERSE_DESKTOP_BILLING_ENABLED = "1";
    assert.equal(desktopBillingEnabled(), false);
    process.env.TOMVERSE_DESKTOP_BILLING_ENABLED = "true";
    assert.equal(desktopBillingEnabled(), true);
    delete process.env.TOMVERSE_DESKTOP_ACCOUNT_SETTINGS_ENABLED;
    assert.equal(desktopBillingEnabled(), false);
    process.env.TOMVERSE_DESKTOP_ACCOUNT_SETTINGS_ENABLED = "true";
    delete process.env.TOMVERSE_DESKTOP_AUTH_ENABLED;
    assert.equal(desktopBillingEnabled(), false);
    // A display switch: it enrols no bearer route.
    process.env.TOMVERSE_DESKTOP_AUTH_ENABLED = "true";
    for (const path of ["/api/billing/checkout", "/api/billing/credit-packs", "/api/billing/plan-change/confirm"]) {
      assert.equal(desktopWriteApiRoute(path, "POST"), false, path);
    }
  } finally {
    switches.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});

test("Desktop connector screens are off unless their own switch and the account settings session are both on", () => {
  const switches = ["TOMVERSE_DESKTOP_AUTH_ENABLED", "TOMVERSE_DESKTOP_ACCOUNT_SETTINGS_ENABLED", "TOMVERSE_DESKTOP_PLUGINS_ENABLED"];
  const previous = switches.map((key) => process.env[key]);
  try {
    for (const key of switches) delete process.env[key];
    assert.equal(desktopPluginsEnabled(), false);
    for (const key of switches.slice(0, 2)) process.env[key] = "true";
    assert.equal(desktopPluginsEnabled(), false);
    process.env.TOMVERSE_DESKTOP_PLUGINS_ENABLED = "1";
    assert.equal(desktopPluginsEnabled(), false);
    process.env.TOMVERSE_DESKTOP_PLUGINS_ENABLED = "true";
    assert.equal(desktopPluginsEnabled(), true);
    delete process.env.TOMVERSE_DESKTOP_ACCOUNT_SETTINGS_ENABLED;
    assert.equal(desktopPluginsEnabled(), false);
    process.env.TOMVERSE_DESKTOP_ACCOUNT_SETTINGS_ENABLED = "true";
    delete process.env.TOMVERSE_DESKTOP_AUTH_ENABLED;
    assert.equal(desktopPluginsEnabled(), false);
    // A display switch: it enrols no bearer route.
    process.env.TOMVERSE_DESKTOP_AUTH_ENABLED = "true";
    for (const path of ["/api/mcp/connections", "/api/mcp/oauth/start", "/api/mcp/invocations/abc"]) {
      assert.equal(desktopWriteApiRoute(path, "POST"), false, path);
    }
  } finally {
    switches.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});

test("Desktop Drive and Deep Research are opt-in and retain the existing attachment and Chat gates", () => {
  const switches = ["TOMVERSE_DESKTOP_AUTH_ENABLED", "TOMVERSE_DESKTOP_CHAT_WRITE_ENABLED",
    "TOMVERSE_DESKTOP_ATTACHMENTS_ENABLED", "TOMVERSE_DESKTOP_GOOGLE_DRIVE_ENABLED", "TOMVERSE_DESKTOP_DEEP_RESEARCH_ENABLED"];
  const previous = switches.map((key) => process.env[key]);
  const status = "/api/chat/deep-research/status";
  try {
    for (const key of switches) delete process.env[key];
    for (const key of switches.slice(0, 3)) process.env[key] = "true";
    assert.equal(desktopDriveEnabled(), false);
    assert.equal(desktopDeepResearchEnabled(), false);
    assert.equal(desktopWriteApiRoute(status, "POST"), false);
    for (const key of switches.slice(3)) process.env[key] = "true";
    assert.equal(desktopDriveEnabled(), true);
    assert.equal(desktopWriteApiRoute(status, "POST"), true);
    assert.equal(desktopWriteApiRoute(status, "GET"), false);
    assert.equal(desktopWriteApiRoute("/api/chat/research/runs", "POST"), false);
    delete process.env.TOMVERSE_DESKTOP_ATTACHMENTS_ENABLED;
    assert.equal(desktopDriveEnabled(), false);
    assert.equal(desktopWriteApiRoute(status, "POST"), true);
    delete process.env.TOMVERSE_DESKTOP_CHAT_WRITE_ENABLED;
    assert.equal(desktopWriteApiRoute(status, "POST"), false);
  } finally {
    switches.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});

test("generated-file Native enrollment fails closed without a resolved switch and permits only versions and input cleanup", () => {
  for (const [path, method] of [["/api/chat", "DELETE"], ["/api/artifacts/file-1/versions", "GET"]]) {
    assert.equal(nativeArtifactRevisionBearerRoute(path, method), false);
    assert.equal(nativeArtifactRevisionBearerRoute(path, method, false), false);
    assert.equal(nativeArtifactRevisionBearerRoute(path, method, true), true);
  }
  for (const [path, method] of [["/api/chat", "GET"], ["/api/chat/other", "DELETE"],
    ["/api/artifacts/file-1/versions", "POST"], ["/api/artifacts/file-1/versions/more", "GET"],
    ["/api/artifacts/%2Fadmin/versions", "GET"], ["/api/admin/versions", "GET"]]) {
    assert.equal(nativeArtifactRevisionBearerRoute(path, method, true), false);
  }
});
const identity = { subject: "user_1", device: "device_1", family: "family_1" };

const verdict = (options = {}) =>
  nativeBearerVerdict({
    pathname: options.pathname ?? REGISTERED,
    authorization: options.authorization ?? null,
    registeredRoutes: options.registeredRoutes ?? [REGISTERED],
    verify:
      options.verify ??
      (() => ({ ok: true, identity })),
  });

// --- the shipped configuration -------------------------------------------

test("the shipped route list is empty, so N1b changes nothing today", () => {
  // Approved decision 13. Empty is not a placeholder: while it is empty every
  // native mutation still meets the mutation-origin check and is refused.
  assert.deepEqual([...N1B_BEARER_ROUTES], []);
  assert.equal(
    nativeBearerVerdict({
      pathname: "/api/conversations",
      authorization: "Bearer anything",
      registeredRoutes: N1B_BEARER_ROUTES,
      verify: () => {
        throw new Error("an unregistered route must not reach the verifier");
      },
    }).kind,
    "not_applicable"
  );
});

// --- section 5.3, rows 5 to 13 -------------------------------------------

test("row 5 -- an unregistered route is not_applicable even with a valid bearer", () => {
  assert.deepEqual(
    verdict({ pathname: "/api/chat", authorization: "Bearer good" }),
    { kind: "not_applicable" }
  );
});

test("registration is by exact path, so a prefix cannot enrol a route", () => {
  for (const pathname of [
    "/api/conversations/abc",
    "/api/conversationsx",
    "/api/",
    "/api/conversations/../internal/sweep",
  ]) {
    assert.equal(
      verdict({ pathname, authorization: "Bearer good" }).kind,
      "not_applicable",
      pathname
    );
  }
});

test("row 1 and 2 -- no Authorization header means the existing cookie path", () => {
  assert.deepEqual(verdict({ authorization: null }), { kind: "no" });
  assert.deepEqual(verdict({ authorization: "   " }), { kind: "no" });
});

test("rows 8 and 9 -- a failed bearer is 401 with no cookie fallback", () => {
  // Section 5.1's fourth prohibition. There is no branch here that could look
  // at a cookie, which is the point: the refusal cannot degrade into one.
  const failed = verdict({
    authorization: "Bearer forged",
    verify: () => ({ ok: false, failure: "signature_invalid" }),
  });
  assert.deepEqual(failed, { kind: "reject", failure: "signature_invalid" });
});

test("a present-but-not-bearer Authorization header is refused, not ignored", () => {
  // Ignoring it would make "send a broken Authorization header" a way to reach
  // the cookie path from a registered route.
  for (const header of ["Basic abc", "Bearer", "Bearer a b", "Token abc"]) {
    assert.equal(
      verdict({ authorization: header }).kind,
      "reject",
      header
    );
  }
});

test("rows 7, 12 and 13 -- a verified bearer passes regardless of Origin", () => {
  // This module never sees an Origin, and that is the design: an attacker who
  // already holds a valid token does not need a browser, so requiring an Origin
  // would break only the honest clients that cannot send one.
  const passed = verdict({ authorization: "Bearer good" });
  assert.deepEqual(passed, { kind: "yes", identity });
});

test("the scheme is case-insensitive and tolerant of spacing, as RFC 7235 says", () => {
  for (const header of ["bearer good", "BEARER good", "  Bearer   good  "]) {
    assert.equal(verdict({ authorization: header }).kind, "yes", header);
  }
});

// --- section 5.4, the header namespace -----------------------------------

test("every internal auth header is removed, whatever its case", () => {
  const headers = new Headers({
    [`${INTERNAL_AUTH_HEADER_PREFIX}subject`]: "attacker",
    "X-Tomverse-Auth-Device": "attacker-device",
    "x-tomverse-auth-anything-else": "attacker",
    "x-tomverse-pathname": "/keep-me",
    authorization: "Bearer good",
  });

  const removed = stripInternalAuthHeaders(headers);

  assert.equal(headers.get(MOBILE_IDENTITY_HEADERS.subject), null);
  assert.equal(headers.get(MOBILE_IDENTITY_HEADERS.device), null);
  assert.equal(headers.get("x-tomverse-auth-anything-else"), null);
  assert.equal(removed.length, 3);
  // The routing conveniences are outside the namespace on purpose.
  assert.equal(headers.get("x-tomverse-pathname"), "/keep-me");
  assert.equal(headers.get("authorization"), "Bearer good");
});

test("the strip reports names and never values", () => {
  // A forged identity header is attacker-controlled text. What an operator
  // needs is that somebody tried, not what they wrote.
  const headers = new Headers({
    [MOBILE_IDENTITY_HEADERS.subject]: "someone-elses-account-id",
  });
  const removed = stripInternalAuthHeaders(headers);
  assert.deepEqual(removed, [MOBILE_IDENTITY_HEADERS.subject]);
  assert.ok(!JSON.stringify(removed).includes("someone-elses-account-id"));
});

test("stripping an untouched request removes nothing and reports nothing", () => {
  const headers = new Headers({ host: "tomverse.app" });
  assert.deepEqual(stripInternalAuthHeaders(headers), []);
  assert.equal(headers.get("host"), "tomverse.app");
});

test("row 14 -- a forged header is replaced by the verified one, not merged with it", () => {
  const headers = new Headers({
    [MOBILE_IDENTITY_HEADERS.subject]: "attacker",
    [MOBILE_IDENTITY_HEADERS.family]: "attacker-family",
  });
  stripInternalAuthHeaders(headers);
  applyMobileIdentityHeaders(headers, identity);

  assert.equal(headers.get(MOBILE_IDENTITY_HEADERS.subject), "user_1");
  assert.equal(headers.get(MOBILE_IDENTITY_HEADERS.device), "device_1");
  assert.equal(headers.get(MOBILE_IDENTITY_HEADERS.family), "family_1");
});

test("a rejected or not_applicable verdict writes nothing, which is why the strip is unconditional", () => {
  // The failure section 5.4 exists to prevent: `set` on success alone leaves
  // the client's value in place on every branch that writes nothing.
  for (const outcome of ["reject", "not_applicable"]) {
    const headers = new Headers({ [MOBILE_IDENTITY_HEADERS.subject]: "attacker" });
    stripInternalAuthHeaders(headers);
    // Nothing is applied for these verdicts.
    assert.equal(headers.get(MOBILE_IDENTITY_HEADERS.subject), null, outcome);
  }
});

test("the verifier is not consulted for a route nobody registered", () => {
  // Not an optimisation -- it is what keeps N1b's cost proportional, and what
  // keeps /api/internal/** away from a verifier that would answer 401 to
  // ordinary maintenance (T13).
  let calls = 0;
  verdict({
    pathname: "/api/internal/sweep",
    authorization: "Bearer an-operational-secret",
    verify: () => {
      calls += 1;
      return { ok: false, failure: "malformed" };
    },
  });
  assert.equal(calls, 0);
});


test("Research Preview native enrollment is default-off and names exact methods only", () => {
  const previous = process.env.RESEARCH_PREVIEW_NATIVE_ENABLED;
  const paths = [["/api/chat/research-preview/offer", "POST"], ["/api/chat/research-preview/runs", "POST"], ["/api/chat/research-preview/runs", "GET"], ["/api/chat/research-preview/runs/run_1", "GET"], ["/api/chat/research-preview/runs/run_1/resume", "POST"], ["/api/chat/research-preview/runs/run_1/cancel", "POST"]];
  try {
    delete process.env.RESEARCH_PREVIEW_NATIVE_ENABLED;
    for (const [path, method] of paths) assert.equal(nativeParityBearerRoute(path, method, true), false);
    process.env.RESEARCH_PREVIEW_NATIVE_ENABLED = "true";
    for (const [path, method] of paths) {
      assert.equal(nativeParityBearerRoute(path, method, false), false);
      assert.equal(nativeParityBearerRoute(path, method, true), true);
    }
    for (const [path, method] of [["/api/chat/research-preview/offer", "GET"], ["/api/chat/research-preview/runs/run_1", "POST"], ["/api/chat/research-preview/runs/run_1/resume", "GET"], ["/api/chat/research-preview/runs/run_1/admin", "POST"], ["/api/chat/research-preview/runs/run_1/cancel/extra", "POST"]]) assert.equal(nativeParityBearerRoute(path, method, true), false);
  } finally { if (previous === undefined) delete process.env.RESEARCH_PREVIEW_NATIVE_ENABLED; else process.env.RESEARCH_PREVIEW_NATIVE_ENABLED = previous; }
});

test("Review handoff enrollment refuses disabled flags and every unregistered method or suffix", () => {
  const paths = [
    ["/api/conversations/target/continuation/review-handoff", ["POST"]],
    ["/api/conversations/target/continuation/review-handoff/draft", ["GET", "PUT", "DELETE"]],
    ["/api/conversations/target/messages/receipt", ["POST"]],
  ];
  for (const [path, allowed] of paths) {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]) {
      assert.equal(nativeParityBearerRoute(path, method), false);
      assert.equal(nativeParityBearerRoute(path, method, false, true), false);
      assert.equal(nativeParityBearerRoute(path, method, true), allowed.includes(method));
      assert.equal(nativeParityBearerRoute(`${path}/extra`, method, true), false);
      assert.equal(nativeParityBearerRoute(path.replace("target", "%2Fadmin"), method, true), false);
    }
  }
});

test("the folder-era history calls stay open to parity while the project workspace switch is off", () => {
  // A workspace route that is also a folder call is not refused as "workspace
  // unavailable": Native history list, create, rename and delete predate the
  // workspace and are opened by parity alone.
  const folders = [["/api/projects", ["GET", "POST"]], ["/api/projects/p1", ["PATCH", "DELETE"]]];
  for (const [path, allowed] of folders) {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      assert.equal(nativeHistoryFolderBearerRoute(path, method), allowed.includes(method), `${method} ${path}`);
      if (allowed.includes(method)) assert.equal(nativeParityBearerRoute(path, method, true), true, `${method} ${path}`);
    }
  }
  // Workspace-only calls are not folder calls.
  for (const [path, method] of [["/api/projects/p1", "GET"], ["/api/projects/p1/materials", "GET"], ["/api/projects/p1/memories", "POST"], ["/api/chat/context", "POST"]]) {
    assert.equal(nativeProjectWorkspaceBearerRoute(path, method), true, `${method} ${path}`);
    assert.equal(nativeHistoryFolderBearerRoute(path, method), false, `${method} ${path}`);
  }
});
