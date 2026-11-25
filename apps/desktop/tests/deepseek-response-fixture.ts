import type { ServerResponse } from "node:http";

export function sendDeepSeekResponse(response: ServerResponse, model: string, index: number,
  result: string | { name: string; args: object } = "The workspace task finished.") {
  const tool = typeof result === "string" ? undefined : result;
  const text = typeof result === "string" ? result : "";
  const send = (type: string, fields: object = {}) =>
    response.write("event: " + type + "\ndata: " + JSON.stringify({ type, ...fields }) + "\n\n");
  response.writeHead(200, { "content-type": "text/event-stream" });
  send("message_start", { message: { id: "msg_" + index, type: "message", role: "assistant", content: [], model,
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 14, output_tokens: 0 } } });
  send("content_block_start", { index: 0, content_block: tool
    ? { type: "tool_use", id: "toolu_" + index, name: tool.name, input: {} } : { type: "text", text: "" } });
  if (tool || text) send("content_block_delta", { index: 0, delta: tool
    ? { type: "input_json_delta", partial_json: JSON.stringify(tool.args) } : { type: "text_delta", text } });
  send("content_block_stop", { index: 0 });
  send("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null },
    usage: { output_tokens: tool || text ? 5 : 0 } });
  send("message_stop");
  response.end();
}
