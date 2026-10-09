import { writeFileSync } from "node:fs";

let buffer = Buffer.alloc(0);
const methods = [];
const send = (message) => {
  const body = Buffer.from(JSON.stringify(message));
  const frame = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
  process.stdout.write(frame.subarray(0, 15));
  setTimeout(() => process.stdout.write(frame.subarray(15)), 10);
};
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const at = buffer.indexOf("\r\n\r\n");
    if (at === -1) return;
    const length = Number(/Content-Length: (\d+)/.exec(buffer.subarray(0, at).toString())[1]);
    if (buffer.length < at + 4 + length) return;
    const message = JSON.parse(buffer.subarray(at + 4, at + 4 + length));
    buffer = buffer.subarray(at + 4 + length);
    methods.push(message.method);
    if (message.method === "connect" && process.env.FAKE_QUOTA_LEGACY === "true") {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unknown method" } });
    } else if (message.method === "connect" || message.method === "ping") {
      send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 3 } });
    } else if (message.method === "account.getQuota") {
      writeFileSync(process.env.FAKE_QUOTA_LOG, JSON.stringify({ methods,
        tokenPassed: message.params.gitHubToken === process.env.COPILOT_GITHUB_TOKEN }));
      if (process.env.FAKE_QUOTA_OVERSIZE === "true") {
        process.stdout.write("Content-Length: 128001\r\n\r\n");
      } else {
        send({ jsonrpc: "2.0", id: message.id, result: JSON.parse(process.env.FAKE_QUOTA_RESULT) });
      }
    } else {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unexpected method" } });
    }
  }
});
