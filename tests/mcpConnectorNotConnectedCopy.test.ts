import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { mcpConnectorCopy } from "../lib/mcpConnectorCopy";

const workspace = readFileSync(new URL("../components/plugins/PluginWorkspace.tsx", import.meta.url), "utf8");

test("a plugin that was never connected reads as not connected, not as a finished disconnect", () => {
  assert.equal(mcpConnectorCopy.ko.notConnected, "연결 안 됨");
  assert.equal(mcpConnectorCopy.en.notConnected, "Not connected");
  assert.equal(mcpConnectorCopy.ko.disconnected, "연결 해제됨");
  for (const copy of Object.values(mcpConnectorCopy)) assert.notEqual(copy.notConnected, copy.disconnected);
  const footer = workspace.match(/className=\{styles\.cardFooter\}><span>\{([^\n]*?)\}<\/span>/)?.[1] ?? "";
  assert.match(footer, /card\.server \? c\.notConnected/);
  assert.doesNotMatch(footer, /c\.disconnected/);
});
