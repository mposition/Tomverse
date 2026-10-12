import assert from "node:assert/strict";
import test from "node:test";
import { amuxReviewReadError } from "../lib/amux/reviewReadErrorCore.ts";

test("protected review reads distinguish authentication, disabled approval and proxy configuration", () => {
  assert.equal(amuxReviewReadError(428, null), "reauthentication");
  assert.equal(amuxReviewReadError(503, "ADMIN_REAUTHENTICATION_REQUIRED"), "reauthentication");
  assert.equal(amuxReviewReadError(409, "AMUX_AGENT_APPROVAL_UNAVAILABLE"), "disabled");
  for (const code of ["AMUX_REVIEW_PROXY_CONFIG_INVALID", "AMUX_REVIEW_PROXY_ORIGIN_MISMATCH",
    "AMUX_REVIEW_PROXY_COOKIE_UNAVAILABLE", "AMUX_REVIEW_PROXY_REDIRECT_REFUSED"]) {
    assert.equal(amuxReviewReadError(503, code), "proxy_configuration");
  }
});

test("HTML or code-less access refusals do not become generic refresh advice", () => {
  for (const status of [401, 403, 421]) assert.equal(amuxReviewReadError(status, null), "access_refused");
  assert.equal(amuxReviewReadError(404, null), "not_found");
});

test("busy reads and arbitrary upstream text use fixed messages, never write retry semantics", () => {
  for (const status of [429, 503, 504]) assert.equal(amuxReviewReadError(status, null), "temporarily_unavailable");
  assert.equal(amuxReviewReadError(500, "untrusted <script> secret text"), "load_failed");
  assert.equal(amuxReviewReadError(409, "AMUX_REVIEW_SUBJECT_CHANGED"), "load_failed");
});
