import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";

type Block = { name: string; input: object } | { text: string };

export function writeClaudeResponse(response: ServerResponse, model: string, index: number, output: Block,
  stream?: { firstDelta: string; rest: Promise<void> }) {
  const send = (type: string, data: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  response.writeHead(200, { "content-type": "text/event-stream", "request-id": `req_fixture_${index}` });
  send("message_start", { message: {
    id: `msg_fixture_${index}`, type: "message", role: "assistant", model, content: [], stop_reason: null,
    stop_sequence: null, usage: { input_tokens: 15, output_tokens: 1 },
  } });
  const finish = (reason: "tool_use" | "end_turn") => {
    send("content_block_stop", { index: 0 });
    send("message_delta", { delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 8 } });
    send("message_stop", {});
    response.end();
  };
  if ("name" in output) {
    send("content_block_start", { index: 0, content_block: { type: "tool_use", name: output.name, id: `toolu_fixture_${index}`, input: {} } });
    send("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(output.input) } });
    finish("tool_use");
    return;
  }
  send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
  const delta = (text: string) => send("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
  if (stream) {
    delta(stream.firstDelta);
    return stream.rest.then(() => {
      if (response.destroyed) return;
      delta(output.text.slice(stream.firstDelta.length));
      finish("end_turn");
    });
  }
  delta(output.text);
  finish("end_turn");
}

export function claudeReadScenario(paths: { inside: string; outside: string; denied: string }, rest?: Promise<void>,
  revision?: { read: string; ready: Promise<void>; stopReady: Promise<void> }) {
  const model = "claude-haiku-4-5-20251001";
  const marker = "Tomverse synthetic Claude read marker";
  const outsideMarker = "Outside fixture content must remain unread";
  const inspect = "Read the local marker";
  const scope = "Check the workspace boundary";
  const first = "The restricted Claude inspection";
  const answer = `${first} is complete.`;
  const followUp = "Reopen the marker task and check the updated notes.";
  const steer = "Before completing the revised task, read the marker once more.";
  const cancelled = "This instruction must remain in the composer.";
  const projectHook = "Respond with the local Claude project hook marker.";
  const projectMcpPath = "/project-mcp";
  const revised = "Verify the revised marker task";
  const revisedAnswer = "The revised inspection is complete.";
  const revisedMarker = "Tomverse synthetic revised marker";
  const firstAnalysis = { objective: "Inspect the search marker", verifiedFacts: [marker], assumptions: ["The marker describes the selected search behavior."],
    scope: "The selected workspace fixture", verification: "Review the project read receipts", completion: "Report an ordered plan for the selected scope" };
  const revisedAnalysis = { ...firstAnalysis, objective: "Inspect the revised search marker", verifiedFacts: [revisedMarker] };
  const stopTask = "Wait for a response before stopping";
  const savedPrompt = "Prepare a plan and stop while waiting";
  const savedInstruction = "Inspect the full marker before the next step.";
  const continuedAnswer = "The saved marker inspection is complete.";
  const crashPrompt = "Collect two read receipts before losing the Code worker.";
  const crashTask = "Check the selected project and its boundary";
  const operations = [
    { name: "TaskCreate", input: { subject: inspect, description: "Inspect the selected fixture", activeForm: "Reading local marker" } },
    { name: "TaskUpdate", input: { taskId: "1", status: "in_progress" } },
    { name: "Read", input: { file_path: paths.inside } },
    { name: "TaskUpdate", input: { taskId: "1", status: "completed", description: JSON.stringify(firstAnalysis) } },
    { name: "TaskCreate", input: { subject: scope, description: "Check the selected project's scope", activeForm: "Checking the boundary" } },
    { name: "TaskUpdate", input: { taskId: "2", status: "in_progress" } },
    { name: "Read", input: { file_path: paths.outside } },
    { name: "Write", input: { file_path: paths.denied, content: "This fixture file must not be written." } },
    { name: "TaskUpdate", input: { taskId: "2", status: "completed" } },
  ];
  const revisedOperations = revision && [
    { name: "TaskUpdate", input: { taskId: "1", subject: revised, status: "in_progress" } },
    { name: "Read", input: { file_path: paths.inside } },
    { name: "Read", input: { file_path: revision.read } },
    { name: "TaskUpdate", input: { taskId: "1", status: "completed", description: JSON.stringify(revisedAnalysis) } },
  ];
  let requests = 0;
  let transientRetries = 0;
  let endpointError: unknown;
  let stopRequestClosed = false;
  let crashRequestClosed = false;
  let projectMcpRequests = 0;
  const endpoint = createServer(async (request, response) => {
    if (new URL(request.url ?? "/", "http://127.0.0.1").pathname === projectMcpPath) {
      projectMcpRequests++;
      response.writeHead(503).end();
      return;
    }
    if (request.method === "HEAD" && request.url === "/api/hello") {
      response.writeHead(404).end();
      return;
    }
    try {
      assert.equal(request.method, "POST");
      assert.equal(new URL(request.url ?? "/", "http://127.0.0.1").pathname, "/v1/messages");
      assert.equal(request.headers["x-api-key"], "sk-ant-tomverse-loopback-only");
      const parts: Buffer[] = [];
      let bytes = 0;
      for await (const part of request) {
        bytes += part.length;
        assert.ok(bytes < 512_000);
        parts.push(part);
      }
      const raw = Buffer.concat(parts).toString("utf8");
      const body = JSON.parse(raw);
      assert.equal(body.model, model);
      assert.deepEqual(body.tools.map(({ name }: { name: string }) => name), ["Read", "TaskCreate", "TaskUpdate"]);
      if (requests === 0) assert.match(JSON.stringify(body.system), /ask a focused question and wait/);
      assert.ok(!raw.includes(outsideMarker));
      assert.ok(!raw.includes(cancelled));
      assert.ok(!raw.includes(projectHook));
      if (revision && requests === 15 && transientRetries === 0) {
        assert.ok(raw.includes(savedPrompt));
        transientRetries += 1;
        response.writeHead(429, { "content-type": "application/json", "retry-after": "1", "request-id": "req_fixture_transient" });
        response.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Temporary rate limit." } }));
        return;
      }
      const index = ++requests;
      assert.equal(raw.includes(followUp), index >= 11 && index <= 15);
      assert.equal(raw.includes(steer), index >= 13 && index <= 15);
      assert.equal(raw.split(savedPrompt).length - 1, index >= 16 && index <= 22 ? 1 : 0);
      assert.equal(raw.split(savedInstruction).length - 1, index >= 18 && index <= 22 ? 1 : 0);
      assert.equal(raw.includes("Continue the stopped task from its saved context."), index >= 20 && index <= 22);
      assert.equal(raw.split(crashPrompt).length - 1, index >= 23 ? 1 : 0);
      const previous = body.messages.at(-1)?.content?.find((item: { type?: string }) => item.type === "tool_result");
      if (index === 4) {
        assert.equal(previous?.tool_use_id, "toolu_fixture_3");
        assert.match(previous?.content, /Tomverse synthetic Claude read marker/);
      }
      if (index === 8 || index === 9) {
        assert.equal(previous?.tool_use_id, `toolu_fixture_${index - 1}`);
        assert.equal(previous?.is_error, true);
        assert.match(previous?.content, index === 8 ? /outside.*confines the file tools/i : /No such tool available: Write/);
      }
      if (revision && index === 12) await revision.ready;
      if (index === 14) assert.match(previous?.content, /Tomverse synthetic revised marker/);
      const tool = index <= 9 ? operations[index - 1] : revisedOperations?.[index - 11];
      if (tool) writeClaudeResponse(response, model, index, tool);
      else if (revision && index === 15) writeClaudeResponse(response, model, index, { text: revisedAnswer });
      else if (revision && index === 16) {
        writeClaudeResponse(response, model, index, { name: "TaskCreate", input: {
          subject: stopTask, description: "Wait in the temporary test", activeForm: "Waiting",
        } });
      } else if (revision && index === 17) {
        await revision.stopReady;
        writeClaudeResponse(response, model, index, { name: "TaskUpdate", input: { taskId: "1", status: "in_progress" } });
      } else if (revision && index === 18) {
        writeClaudeResponse(response, model, index, { name: "Read", input: { file_path: paths.inside } });
      } else if (revision && index === 19) {
        response.once("close", () => { stopRequestClosed = true; });
      } else if (revision && index === 20) {
        writeClaudeResponse(response, model, index, { name: "Read", input: { file_path: revision.read } });
      } else if (revision && index === 21) {
        assert.match(previous?.content, /Tomverse synthetic revised marker/);
        writeClaudeResponse(response, model, index, { name: "TaskUpdate", input: { taskId: "1", status: "completed" } });
      } else if (revision && index === 22) {
        writeClaudeResponse(response, model, index, { text: continuedAnswer });
      } else if (revision && index === 23) {
        writeClaudeResponse(response, model, index, { name: "TaskCreate", input: {
          subject: crashTask, description: "Check the fixture boundary", activeForm: "Checking local files",
        } });
      } else if (revision && index === 24) {
        writeClaudeResponse(response, model, index, { name: "TaskUpdate", input: { taskId: "1", status: "in_progress" } });
      } else if (revision && index === 25) {
        writeClaudeResponse(response, model, index, { name: "Read", input: { file_path: paths.inside } });
      } else if (revision && index === 26) {
        assert.match(previous?.content, /Tomverse synthetic Claude read marker/);
        writeClaudeResponse(response, model, index, { name: "Read", input: { file_path: paths.outside } });
      } else if (revision && index === 27) {
        assert.equal(previous?.is_error, true);
        response.once("close", () => { crashRequestClosed = true; });
      } else {
        assert.equal(index, 10);
        await writeClaudeResponse(response, model, index, { text: answer }, rest ? { firstDelta: first, rest } : undefined);
      }
    } catch (error) {
      endpointError = error;
      response.writeHead(400).end("Unexpected loopback fixture request.");
    }
  });
  endpoint.on("connect", (_request, socket) => socket.destroy());
  return { endpoint, model, marker, outsideMarker, inspect, scope, first, answer, followUp, steer, cancelled, revised, revisedAnswer, revisedMarker,
    stopTask, savedPrompt, savedInstruction, continuedAnswer, crashPrompt, crashTask, projectHook, projectMcpPath, firstAnalysis, revisedAnalysis,
    get requests() { return requests; }, get transientRetries() { return transientRetries; },
    get projectMcpRequests() { return projectMcpRequests; },
    get error() { return endpointError; }, get stopRequestClosed() { return stopRequestClosed; },
    get crashRequestClosed() { return crashRequestClosed; } };
}
