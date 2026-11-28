import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Workspace } from "../../tomverse-cli/src/workspace.js";
import type { ToolContext } from "../../tomverse-cli/src/tools.js";
import { planPatchCall, patchSchema } from "../../tomverse-cli/src/tools.js";
import { acpEdits } from "../src/host/acp-edits";

for (const provider of ["Qwen", "Kimi"]) for (const revisePlan of [false, true]) test(
  `${provider} ACP refuses ${revisePlan ? "a write after the approved analysis changes" : "a write that differs from the approved patch"}`, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tomverse-acp-edits-")));
  try {
    const workspace = new Workspace(root, []);
    const signal = new AbortController().signal;
    const path = join(root, "note.txt");
    const content = "Approved test content.\n";
    const kimi = provider === "Kimi";
    const replies: Array<[string | number, unknown]> = [];
    let acceptPermission!: () => void;
    const permitted = new Promise<void>((resolve) => { acceptPermission = resolve; });
    let applied = 0;
    let currentAnalysis = true;
    const edits = acpEdits(workspace, {
      spec: { type: "function", name: "desktop_apply_patch", description: "Synthetic edit", inputSchema: {} },
      async invoke(id, raw, _signal, waitForWrite) {
        const input = patchSchema.parse(raw);
        const patch = planPatchCall({ workspace } satisfies Pick<ToolContext, "workspace">, input);
        const allowed = await waitForWrite?.({ approvalId: id, toolCallId: id, toolName: "apply_patch", input, patch, root }, signal);
        if (allowed) applied++;
        return { success: allowed === true, text: "Fixture receipt." };
      },
    }, signal, (id, reply) => {
      replies.push([id, reply]);
      if (id === 2) acceptPermission();
    }, (id) => { replies.push([id, "denied"]); }, (id) => id === "call" && currentAnalysis,
    kimi ? () => ({ path, content }) : undefined);
    const request = { path, content, ...(!kimi && { _meta: { "qwen-code/tool-write-origin": { version: 1, source: "write_file" } } }) };
    edits.write(1, request);
    const toolCall = kimi ? { toolCallId: "call", title: "Write" } :
      { toolCallId: "call", status: "pending", kind: "edit", rawInput: { file_path: path, content },
        content: [{ type: "diff", path, oldText: "", newText: content }], _meta: { toolName: "write_file" } };
    edits.permission(2, { options: [{ optionId: "once", kind: "allow_once" }, { optionId: "deny", kind: "reject_once" }],
      toolCall });
    await permitted;
    currentAnalysis = !revisePlan;
    edits.write(3, revisePlan ? request : { ...request, content: "Different content." });
    edits.write(4, request);
    await edits.close();
    assert.equal(applied, 0);
    assert.equal(edits.written("call"), false);
    assert.deepEqual(replies.slice(0, 2), [[1, "denied"], [2, { outcome: { outcome: "selected", optionId: "once" } }]]);
    assert.deepEqual(replies.slice(2).sort(([first], [second]) => Number(first) - Number(second)), [[3, "denied"], [4, "denied"]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
