import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FileToolsField } from "@/components/admin/AdminModelRegistryPanel";
import { adminModelRegistryMessages } from "@/lib/adminMessages/modelRegistry";

// The catalogue's file-tool tick (lib/generatedArtifactToolPolicy.ts): a new
// model arrives ticked or unticked by the code, and an administrator's click
// is shown as theirs, with a way back to automatic.

const messages = adminModelRegistryMessages.ko.capabilities;
const render = (form: Record<string, unknown>) =>
  renderToStaticMarkup(
    <FileToolsField
      form={{ id: "m", provider: "openai", usageClass: "standard", fileToolsOverride: null, ...form } as never}
      messages={messages}
      onChange={() => {}}
    />
  );
const ticked = (html: string) => /data-testid="model-file-tools"[^>]*checked=""|checked=""[^>]*data-testid="model-file-tools"/.test(html);

test("a newly added Anthropic model is ticked automatically, and says so", () => {
  const html = render({ id: "claude-haiku-5-5", provider: "anthropic" });
  assert.equal(ticked(html), true);
  assert.match(html, /자동: 켜짐/);
  assert.doesNotMatch(html, /model-file-tools-reset/);
});

test("a provider the code does not recognise starts unticked", () => {
  const html = render({ id: "qwen3-8-flash", provider: "qwen" });
  assert.equal(ticked(html), false);
  assert.match(html, /자동: 꺼짐/);
});

test("an administrator's tick is shown as theirs, with the way back", () => {
  const on = render({ id: "qwen3-8-flash", provider: "qwen", fileToolsOverride: true });
  assert.equal(ticked(on), true);
  assert.match(on, /관리자가 정한 값입니다 \(자동이라면 꺼짐\)/);
  assert.match(on, /model-file-tools-reset/);
  const off = render({ id: "gpt-6-luna", provider: "openai", fileToolsOverride: false });
  assert.equal(ticked(off), false);
  assert.match(off, /자동이라면 켜짐/);
});
