import { get } from "node:https";
import {
  AGENT_OFFICE_CLI_WORKER, AGENT_OFFICE_CLI_WORKERS, agentOfficeCliProvider,
  isAgentOfficeCliWorker, agentOfficeCliSnapshotSchema, maskAgentOfficeCliText,
} from "./agentOfficeCliMonitorCore.ts";

/** Existing AMUX read APIs, deliberately fixed: no generic URL, verbs or
 * shell adapter, and no parsing of provider log files. */
const SOURCE_PATHS = Object.freeze({
  transcript: "transcript?max=40000",
  pane: "peek?lines=80&live=1",
});

export function configuredAgentOfficeCliWorkers(env = process.env) {
  const names = (env.TOMVERSE_AMUX_CLI_MONITOR_WORKERS ?? AGENT_OFFICE_CLI_WORKER).split(",");
  if (!names.length || names.length > AGENT_OFFICE_CLI_WORKERS.length ||
      names.some(name => !isAgentOfficeCliWorker(name)) || new Set(names).size !== names.length)
    throw new TypeError("invalid workers");
  return names;
}

export function readAgentOfficeCliSource(kind, worker = AGENT_OFFICE_CLI_WORKER, env = process.env) {
  if (!Object.hasOwn(SOURCE_PATHS, kind)) throw new TypeError("invalid source");
  if (!isAgentOfficeCliWorker(worker)) throw new TypeError("invalid worker");
  // Claude live frames can suppress pane text already present in its transcript.
  const sourcePath = kind === "pane" && agentOfficeCliProvider(worker) === "claude"
    ? "peek?lines=80" : SOURCE_PATHS[kind];
  const sourceCa = env.TOMVERSE_AMUX_CLI_MONITOR_SOURCE_CA_B64;
  if (typeof sourceCa !== "string" || !sourceCa.length || sourceCa.length > 65_536)
    throw new Error("source_ca_unconfigured");
  return new Promise((resolve, reject) => {
    // Trust the operator-provisioned AMUX certificate only on this connection.
    // Chain and hostname verification stay enabled; Tomverse uses public CAs.
    const request = get({ hostname: "127.0.0.1", port: 8824,
      path: `/api/sessions/${worker}/${sourcePath}`, ca: Buffer.from(sourceCa, "base64"),
      rejectUnauthorized: true, timeout: 8_000,
      headers: { Accept: "application/json" } }, (response) => {
      let size = 0;
      const chunks = [];
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > 1_048_576) response.destroy(new Error("source_limit"));
        else chunks.push(chunk);
      });
      response.on("error", () => reject(new Error("source_unavailable")));
      response.on("end", () => {
        try {
          if (response.statusCode !== 200) throw new Error();
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch { reject(new Error("source_unavailable")); }
      });
    });
    request.on("timeout", () => request.destroy(new Error("source_timeout")));
    request.on("error", () => reject(new Error("source_unavailable")));
  });
}

export function projectAgentOfficeCliSource(transcript, pane, worker = AGENT_OFFICE_CLI_WORKER, now = new Date()) {
  if (!isAgentOfficeCliWorker(worker) || transcript?.name !== worker ||
      transcript.provider !== agentOfficeCliProvider(worker) || pane?.name !== worker ||
      typeof pane.output !== "string") throw new TypeError("source_mismatch");
  const codex = agentOfficeCliProvider(worker) === "codex";
  if (codex ? !Array.isArray(transcript.events) : typeof transcript.output !== "string")
    throw new TypeError("source_mismatch");
  let truncated = false;
  const events = [];
  const add = (kind, value) => {
    if (typeof value !== "string" || !value) return;
    const masked = maskAgentOfficeCliText(value);
    if (masked.length > 4_000) truncated = true;
    events.push({ kind, text: masked.slice(0, 4_000) });
  };
  for (const event of codex ? transcript.events : []) {
    if (event.kind === "user") add("prompt", event.text);
    else if (event.kind === "assistant") add("assistant", event.text);
    else if (event.kind === "tool") {
      add("tool", [event.tool, event.detail].filter(v => typeof v === "string").join("\n"));
      add("output", event.output);
    }
    // Reasoning, plans and unknown event types are deliberately not exported.
  }
  let source = "amux-codex-rollout";
  if (!codex) {
    const hasTranscript = transcript.output.trim().length > 0;
    source = hasTranscript ? "amux-transcript" : "amux-terminal";
    // Preserve supplied text without guessing roles from terminal formatting.
    const output = maskAgentOfficeCliText(hasTranscript ? transcript.output : pane.output);
    if (output.length > 4_000) truncated = true;
    add("output", output.slice(-4_000));
  }
  let bounded = events.slice(-80);
  if (bounded.length !== events.length) truncated = true;
  while (Buffer.byteLength(JSON.stringify(bounded)) > 45_000) { bounded.shift(); truncated = true; }
  const raw = maskAgentOfficeCliText(pane.output);
  if (raw.length > 8_000) truncated = true;
  const snapshot = { worker,
    source, capturedAt: now.toISOString(), truncated,
    events: bounded, rawOutput: raw.slice(-8_000) };
  while (Buffer.byteLength(JSON.stringify(snapshot)) > 65_536 && snapshot.events.length) {
    snapshot.events.shift(); snapshot.truncated = true;
  }
  return agentOfficeCliSnapshotSchema.parse(snapshot);
}

export async function collectAgentOfficeCliSnapshot(worker = AGENT_OFFICE_CLI_WORKER,
  read = kind => readAgentOfficeCliSource(kind, worker)) {
  if (!isAgentOfficeCliWorker(worker)) throw new TypeError("invalid worker");
  const [transcript, pane] = await Promise.all([read("transcript"), read("pane")]);
  return projectAgentOfficeCliSource(transcript, pane, worker);
}

export async function sendAgentOfficeCliSnapshot(snapshot, env = process.env) {
  if (env.TOMVERSE_AMUX_CLI_MONITOR !== "1" || (env.TOMVERSE_AMUX_CLI_MONITOR_SECRET ?? "").length < 32)
    throw new Error("monitor_disabled");
  const url = new URL(env.TOMVERSE_INTERNAL_URL);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) throw new Error("invalid_destination");
  const destination = new URL("/api/internal/amux/cli-monitor", url);
  const response = await fetch(destination, { method: "POST", redirect: "error",
    signal: AbortSignal.timeout(10_000), headers: { "Content-Type": "application/json",
      Authorization: `Bearer ${env.TOMVERSE_AMUX_CLI_MONITOR_SECRET}` },
    body: JSON.stringify(snapshot) });
  await response.body?.cancel();
  if (!response.ok) throw new Error("capture_refused");
}
