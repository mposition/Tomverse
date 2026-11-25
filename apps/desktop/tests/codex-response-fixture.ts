import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";

type Tool = { type: string; name?: string; tools?: Tool[] };
export type CodexRequest = { model?: string; tools?: Tool[]; input?: Array<{ type?: string; output?: unknown }> };
type OutputItem = { type: "function_call"; id: string; call_id: string; name: string; namespace?: string; arguments: string; status: "completed" }
  | { type: "message"; id: string; role: "assistant"; status: "completed"; content: Array<{ type: "output_text"; text: string; annotations: never[] }> };

export const flattenCodexTools = (tools: Tool[], namespace?: string): Array<{ name: string; namespace?: string }> => tools.flatMap((tool) => {
  if (tool.type === "namespace") return flattenCodexTools(tool.tools ?? [], tool.name);
  return tool.type === "function" && typeof tool.name === "string" ? [{ name: tool.name, namespace }] : [];
});

export function codexFixtureCall(tools: ReturnType<typeof flattenCodexTools>, index: number, name: string, args: object): OutputItem {
  const tool = tools.find((entry) => entry.name === name);
  assert.ok(tool, `Codex tools did not include ${name}: ${tools.map((entry) => entry.name).join(", ")}`);
  return { type: "function_call", id: `fc_fixture_${index}`, call_id: `call_fixture_${index}`, name,
    ...(tool.namespace ? { namespace: tool.namespace } : {}), arguments: JSON.stringify(args), status: "completed" };
}

export function codexFixtureAnswer(index: number, text: string): OutputItem {
  return { type: "message", id: `msg_fixture_${index}`, role: "assistant", status: "completed",
    content: [{ type: "output_text", text, annotations: [] }] };
}

export function writeCodexResponse(response: ServerResponse, model: string, index: number, output: OutputItem,
  stream?: { firstDelta: string; rest: Promise<void> }) {
  const metadata = { id: `resp_fixture_${index}`, object: "response", created_at: 1_800_000_000, model, output: [] };
  const event = (type: string, data: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  response.writeHead(200, { "content-type": "text/event-stream" });
  event("response.created", { response: { ...metadata, status: "in_progress" } });
  const initial = stream && output.type === "message" ? { ...output, content: [] } : output;
  event("response.output_item.added", { output_index: 0, item: { ...initial, status: "in_progress" } });
  const finish = () => {
    event("response.output_item.done", { output_index: 0, item: output });
    event("response.completed", { response: { ...metadata, output: [output], status: "completed", usage: {
      input_tokens: 32, output_tokens: 16, total_tokens: 48, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 },
    } } });
    response.end();
  };
  if (stream && output.type === "message") {
    const text = output.content[0]?.text;
    assert.ok(text?.startsWith(stream.firstDelta));
    const delta = (text: string) => event("response.output_text.delta", { item_id: output.id, output_index: 0, content_index: 0, delta: text });
    delta(stream.firstDelta);
    return stream.rest.then(() => {
      if (response.destroyed) return;
      delta(text.slice(stream.firstDelta.length));
      finish();
    });
  }
  finish();
}
