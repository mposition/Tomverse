import assert from "node:assert/strict";
import test from "node:test";
import { chatRouterLocationFusionEnabled, existingChatRouterLocationFusionEnabled } from "../lib/chatRouterLocationFusionEnabled";

test("existing-turn routing requires both master switches and its own opt-in, independently of fresh preparation", t => {
  const settings = ["CHAT_ROUTER_LOCATION_FUSION_ENABLED", "TOMVERSE_CHAT_LOCATION_INTENT_ENABLED",
    "CHAT_EXISTING_ROUTER_LOCATION_FUSION_ENABLED", "CHAT_FRESH_LOCATION_PREPARATION_ENABLED"] as const;
  const original = settings.map(name => process.env[name]);
  t.after(() => settings.forEach((name, index) => {
    if (original[index] === undefined) delete process.env[name]; else process.env[name] = original[index];
  }));
  for (const name of settings) delete process.env[name];
  assert.equal(existingChatRouterLocationFusionEnabled(), false);
  process.env.CHAT_ROUTER_LOCATION_FUSION_ENABLED = "true";
  process.env.TOMVERSE_CHAT_LOCATION_INTENT_ENABLED = "true";
  assert.equal(chatRouterLocationFusionEnabled(), true);
  assert.equal(existingChatRouterLocationFusionEnabled(), false);
  process.env.CHAT_EXISTING_ROUTER_LOCATION_FUSION_ENABLED = "true";
  assert.equal(existingChatRouterLocationFusionEnabled(), true);
  process.env.CHAT_FRESH_LOCATION_PREPARATION_ENABLED = "true";
  assert.equal(chatRouterLocationFusionEnabled(), false);
  assert.equal(existingChatRouterLocationFusionEnabled(), true);
  for (const name of settings.slice(0, 3)) {
    process.env[name] = "false";
    assert.equal(existingChatRouterLocationFusionEnabled(), false);
    process.env[name] = "true";
  }
});
