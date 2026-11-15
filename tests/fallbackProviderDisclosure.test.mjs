import assert from "node:assert/strict";
import test from "node:test";
import { en } from "../locales/en.ts";
import { ko } from "../locales/ko.ts";
import { autoFallbackScope } from "../lib/autoFallbackGate.ts";

const eligible = { routed: true, isGuest: false, toolsOffered: false, nativeSearchEnabled: false,
  deepResearch: false, hasAttachments: false, candidateCount: 1, environment: { AUTO_ROUTER_FALLBACK_ENABLED: "on" } };

test("the disclosure names both recipients and the real fallback exclusions and opt-out", () => {
  assert.equal(autoFallbackScope(eligible).allowed, true);
  for (const patch of [{ routed: false }, { toolsOffered: true }, { nativeSearchEnabled: true }, { appManagedSearchEnabled: true }, { deepResearch: true }, { hasAttachments: true }]) {
    assert.equal(autoFallbackScope({ ...eligible, ...patch }).allowed, false);
  }
  assert.match(en.privacyPolicy.providerTransfer3, /Both providers may receive/);
  assert.match(en.privacyPolicy.providerTransfer3, /attachments, tools, web search or deep research/);
  assert.match(en.privacyPolicy.providerTransfer6, /choose a specific model instead of Auto/);
  assert.match(ko.privacyPolicy.providerTransfer3, /첫 공급자와 대체 공급자 모두/);
  assert.match(ko.privacyPolicy.providerTransfer6, /Auto 대신 특정 모델을 직접 선택/);
});
