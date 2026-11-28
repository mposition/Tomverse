import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Workspace } from "../../tomverse-cli/src/workspace.js";
import type { CodeNativeAssignment, CodeTaskPlan } from "../src/contract";
import { bindClaudeRead } from "../src/host/claude-read";
import { inspectClaudeTranscript } from "../src/host/claude-transcript";
import { bindProjectRoot } from "../src/host/project-root";

test("Claude recovery requires the matching prompt, assistant call and original file binding", async (context) => {
  const temp = await mkdtemp(join(tmpdir(), "tomverse-claude-transcript-"));
  context.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, "project");
  const profile = join(temp, "profile");
  const projectFolder = join(profile, "projects", "fixture");
  await Promise.all([mkdir(root), mkdir(projectFolder, { recursive: true })]);
  const project = bindProjectRoot(root);
  const marker = join(project.path, "marker.txt");
  await writeFile(marker, "Synthetic fixture");
  const session: CodeNativeAssignment = { provider: "anthropic", threadId: randomUUID(), turnId: randomUUID(), model: "fixture-model" };
  const promptId = randomUUID();
  const callId = randomUUID();
  const id = "toolu_fixture";
  const version = "2.1.278";
  const binding = bindClaudeRead(new Workspace(project.path), project, marker);
  assert.ok(binding);
  const plan: CodeTaskPlan = { activeId: null, items: [{
    id: "claude-1", title: "Read fixture", complete: false, cancelled: false, nativeStatus: "in_progress",
    evidence: [{ tool: "read_file", state: "unconfirmed", nativeItemId: id, assignment: session,
      nativeCallId: callId, nativeReadBinding: binding }],
  }] };
  const scope = { cwd: project.path, sessionId: session.threadId, isSidechain: false, version };
  const prompt = { ...scope, uuid: session.turnId, parentUuid: null, type: "user", promptSource: "sdk", permissionMode: "plan", promptId,
    message: { role: "user", content: [{ type: "text", text: "Read marker" }] } };
  const call = { ...scope, uuid: callId, parentUuid: session.turnId, type: "assistant", message: { role: "assistant",
    model: session.model, content: [{ type: "tool_use", name: "Read", id, input: { file_path: marker } }] } };
  const receipt = { ...scope, uuid: randomUUID(), parentUuid: callId, sourceToolAssistantUUID: callId,
    type: "user", promptId, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id }] },
    toolUseResult: { type: "text", file: { filePath: marker } } };
  const path = join(projectFolder, `${session.threadId}.jsonl`);
  async function inspect(...records: object[]) {
    await writeFile(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    return inspectClaudeTranscript({ profile, project, session, version, plan, signal: new AbortController().signal });
  }

  assert.equal((await inspect(prompt, call, receipt))?.get(id), "succeeded");
  assert.equal((await inspect(prompt, call, { ...receipt, promptId: randomUUID() }))?.get(id), "unconfirmed");
  assert.equal((await inspect(prompt, call, { ...receipt, cwd: temp }))?.get(id), "unconfirmed");
  assert.equal((await inspect(prompt, call, { ...receipt, toolUseResult: { ...receipt.toolUseResult, type: "file_unchanged" } }))?.get(id), "failed");
  assert.equal(await inspect(prompt, call, receipt, receipt), undefined);
  assert.equal(await inspect(call, receipt), undefined);

  await rename(marker, join(root, "former-marker.txt"));
  await writeFile(marker, "Replaced fixture");
  assert.equal((await inspect(prompt, call, receipt))?.get(id), "unconfirmed");
});
