import assert from "node:assert/strict";
import test from "node:test";
import { APP_DEFAULTS } from "../../../lib/appDefaults";
import { NEW_CONVERSATION_WEB_SEARCH, sendToolOptions, shownWebSearchMode } from "../src/renderer/new-conversation-search";

test("A new conversation starts in the same web search position as the web workspace", () => {
  assert.equal(NEW_CONVERSATION_WEB_SEARCH, APP_DEFAULTS.defaultWebSearchMode);
  assert.equal(NEW_CONVERSATION_WEB_SEARCH, "always");
});

test("The first request of a new conversation carries the default, and a change the person made wins", () => {
  assert.deepEqual(sendToolOptions(false, undefined), { webSearchMode: "always" });
  assert.deepEqual(sendToolOptions(false, { memoryMode: "off" }), { webSearchMode: "always", memoryMode: "off" });
  assert.deepEqual(sendToolOptions(false, { webSearchMode: "off" }), { webSearchMode: "off" });
});

test("A saved conversation keeps its own value: nothing is added to the request", () => {
  assert.equal(sendToolOptions(true, undefined), undefined);
  assert.deepEqual(sendToolOptions(true, { webSearchMode: "off" }), { webSearchMode: "off" });
});

test("The switch shows the change, else the saved value, else (new conversation only) the default", () => {
  assert.equal(shownWebSearchMode(false, undefined, undefined), "always");
  assert.equal(shownWebSearchMode(false, undefined, { webSearchMode: "off" }), "off");
  assert.equal(shownWebSearchMode(true, "off", undefined), "off");
  assert.equal(shownWebSearchMode(true, "always", { webSearchMode: "off" }), "off");
  assert.equal(shownWebSearchMode(true, undefined, undefined), undefined, "a saved conversation still loading shows no default");
});
