/**
 * The root-owned recovery profile file is read by the box's recovery
 * controller and by the app's recovery parser. A file one of them takes must
 * not be one the other turns away (review r-20261116-223616-da3a14: the
 * controller took 4,096 profiles of 256 workers while the app stopped at 128
 * and 16, so the app answered safe_stop_profile_unavailable).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const number = (text, name) => {
  const match = text.match(new RegExp(`const ${name} = ([0-9_]+);`));
  assert.ok(match, `${name} is not declared`);
  return Number(match[1].replaceAll("_", ""));
};

test("the app's recovery profile bounds are the controller's", () => {
  const controller = read("lib/amux/v22RecoveryController.mjs");
  const app = read("lib/amux/v22TaskRecoveryCore.ts");
  assert.equal(number(app, "RECOVERY_PROFILE_LIMIT"), number(controller, "PROFILE_LIMIT"));
  assert.equal(number(app, "RECOVERY_PROFILE_MEMBER_LIMIT"), number(controller, "MEMBER_LIMIT"));
  // The schema reads the named bounds, not numbers of its own.
  assert.match(app, /\.max\(RECOVERY_PROFILE_MEMBER_LIMIT\)/);
  assert.match(app, /\.max\(RECOVERY_PROFILE_LIMIT\)/);
});

test("one controller request or report with a full profile fits both transport bounds", () => {
  const controller = read("lib/amux/v22RecoveryController.mjs");
  const app = read("lib/amux/v22TaskRecoveryCore.ts");
  const route = read("app/api/internal/amux/v22/recovery-controller/route.ts");
  const bytes = number(app, "AMUX_V22_RECOVERY_CONTROLLER_BODY_MAX_BYTES");
  assert.equal(number(controller, "CONTROLLER_BODY_BYTES"), bytes);
  assert.ok(controller.includes("async function boundedResponse(response, limit = CONTROLLER_BODY_BYTES)"));
  assert.ok(route.includes("readLimitedJson(request, AMUX_V22_RECOVERY_CONTROLLER_BODY_MAX_BYTES,"));
  // 256 names of 64 characters, quoted and comma-separated, plus the fixed
  // fields of a safe-stop request or report (review r-20261116-232116-5ef32a).
  const names = number(app, "RECOVERY_PROFILE_MEMBER_LIMIT") * (64 + 3);
  assert.ok(bytes >= names + 16_384, `${bytes} < ${names + 16_384}`);
});
