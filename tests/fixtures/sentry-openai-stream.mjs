// One streamed OpenAI Responses call through the real AI SDK, with Sentry
// initialised the way the server is (mode "app") or with Sentry's own
// defaults (mode "sentry-default"). The provider is a loopback SSE server:
// no key and no network. Prints one JSON line with the outcome.
import dc from "node:diagnostics_channel";
import { createServer } from "node:http";
import * as Sentry from "@sentry/nextjs";
import { withoutDisabledServerIntegrations } from "../../lib/sentryServerIntegrations.ts";

const mode = process.argv[2];
Sentry.init({
  dsn: "http://public@127.0.0.1:9/1",
  enabled: true,
  tracesSampleRate: 0,
  traceLifecycle: "static",
  ...(mode === "app" ? { integrations: withoutDisabledServerIntegrations } : {}),
});

const { streamText, tool, jsonSchema } = await import("ai");
const { createOpenAI } = await import("@ai-sdk/openai");

const response = (status, output = []) => ({
  id: "resp_1", object: "response", created_at: 1763250000, status, model: "gpt-6-luna",
  output, incomplete_details: null, error: null, service_tier: "default",
  usage: status === "completed"
    ? { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 15 }
    : null,
});
const message = { id: "msg_1", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "Hello there", annotations: [], logprobs: [] }] };
const events = [
  { type: "response.created", response: response("in_progress") },
  { type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } },
  { type: "response.content_part.added", item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [], logprobs: [] } },
  { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "Hello ", logprobs: [] },
  { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "there", logprobs: [] },
  { type: "response.output_text.done", item_id: "msg_1", output_index: 0, content_index: 0, text: "Hello there", logprobs: [] },
  { type: "response.content_part.done", item_id: "msg_1", output_index: 0, content_index: 0, part: message.content[0] },
  { type: "response.output_item.done", output_index: 0, item: message },
  { type: "response.completed", response: response("completed", [message]) },
];

const server = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    events.forEach((event, i) => res.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: i })}\n\n`));
    res.end();
  });
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));

const openai = createOpenAI({ apiKey: "loopback", baseURL: `http://127.0.0.1:${server.address().port}/v1` });
let error = null;
let text = "";
const result = streamText({
  model: openai("gpt-6-luna"),
  messages: [{ role: "user", content: "Say hello." }],
  // Chat turns always carry application tools; a request with tools is the
  // one whose telemetry copy differs from the result the SDK keeps.
  tools: {
    create_text_file: tool({
      description: "Create a text file.",
      inputSchema: jsonSchema({ type: "object", properties: { name: { type: "string" } }, required: ["name"] }),
      execute: async () => ({ ok: true }),
    }),
  },
  onError: ({ error: streamError }) => {
    error = `${streamError?.name ?? "Error"} ${streamError?.code ?? ""}`.trim();
  },
});
try {
  for await (const part of result.textStream) text += part;
} catch (caught) {
  error ??= `${caught?.name ?? "Error"} ${caught?.code ?? ""}`.trim();
}
server.close();
console.log(JSON.stringify({ subscribed: dc.tracingChannel("ai:telemetry").hasSubscribers, text, error }));
process.exit(0);
