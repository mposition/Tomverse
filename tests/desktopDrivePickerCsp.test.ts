import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DESKTOP_DRIVE_PICKER_PATH, createStaticMarketingCsp, createStrictCsp } from "../lib/csp.ts";
import { DESKTOP_DRIVE_PAGE } from "../lib/desktopDrivePickerContract.ts";

const connectSources = (policy: string) => policy.split("; ").find((directive) => directive.startsWith("connect-src "))!;

test("Only the Desktop Google Drive picker page may connect to a loopback port, so it can tell Desktop its window was closed", () => {
  assert.equal(DESKTOP_DRIVE_PICKER_PATH, DESKTOP_DRIVE_PAGE);
  assert.ok(connectSources(createStrictCsp("bm9uY2U=", DESKTOP_DRIVE_PICKER_PATH)).endsWith(" http://127.0.0.1:*"));
  for (const pathname of [undefined, "/", "/chat", "/auth/desktop", "/auth/desktop/drive-picker/other", "/admin/models"]) {
    assert.doesNotMatch(connectSources(createStrictCsp("bm9uY2U=", pathname)), /127\.0\.0\.1|localhost|\*:\*/, String(pathname));
  }
  assert.doesNotMatch(connectSources(createStaticMarketingCsp()), /127\.0\.0\.1/);
});

test("The picker page policy keeps everything else strict", () => {
  const plain = createStrictCsp("bm9uY2U=").replace(connectSources(createStrictCsp("bm9uY2U=")), "");
  const picker = createStrictCsp("bm9uY2U=", DESKTOP_DRIVE_PICKER_PATH).replace(connectSources(createStrictCsp("bm9uY2U=", DESKTOP_DRIVE_PICKER_PATH)), "");
  assert.equal(picker, plain);
});

test("The proxy hands the request path to the strict policy", () => {
  assert.match(readFileSync(new URL("../proxy.ts", import.meta.url), "utf8"), /createStrictCsp\(nonce, request\.nextUrl\.pathname\)/);
});
