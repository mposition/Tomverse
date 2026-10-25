import { get } from "node:https";
import {
  AGENT_OFFICE_CLI_WORKER, agentOfficeCliSnapshotSchema, maskAgentOfficeCliText,
} from "./agentOfficeCliMonitorCore.ts";

/** Existing AMUX read APIs, deliberately fixed: no generic URL, verbs or
 * shell adapter, and no parsing of provider log files. */
const SOURCE_PATHS = Object.freeze({
  transcript: `/api/sessions/${AGENT_OFFICE_CLI_WORKER}/transcript?max=40000`,
  pane: `/api/sessions/${AGENT_OFFICE_CLI_WORKER}/peek?lines=80&live=1`,
});

export function readAgentOfficeCliSource(kind) {
  if (!(kind in SOURCE_PATHS)) throw new TypeError("invalid source");
  return new Promise((resolve, reject) => {
    // The existing loopback AMUX server uses a self-signed certificate.
    // This exception is scoped to this literal address, never to Tomverse.
    const request = get({ hostname: "127.0.0.1", port: 8824,
      path: SOURCE_PATHS[kind], rejectUnauthorized: false, timeout: 8_000,
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

export function projectAgentOfficeCliSource(transcript, pane, now = new Date()) {
  if (transcript?.name !== AGENT_OFFICE_CLI_WORKER || transcript.provider !== "codex" ||
      !Array.isArray(transcript.events) || pane?.name !== AGENT_OFFICE_CLI_WORKER ||
      typeof pane.output !== "string") throw new TypeError("source_mismatch");
  let truncated = false;
  const events = [];
  const add = (kind, value) => {
    if (typeof value !== "string" || !value) return;
    const masked = maskAgentOfficeCliText(value);
    if (masked.length > 4_000) truncated = true;
    events.push({ kind, text: masked.slice(0, 4_000) });
  };
  for (const event of transcript.events) {
    if (event.kind === "user") add("prompt", event.text);
    else if (event.kind === "assistant") add("assistant", event.text);
    else if (event.kind === "tool") {
      add("tool", [event.tool, event.detail].filter(v => typeof v === "string").join("\n"));
      add("output", event.output);
    }
    // Reasoning, plans and unknown event types are deliberately not exported.
  }
  let bounded = events.slice(-80);
  if (bounded.length !== events.length) truncated = true;
  while (Buffer.byteLength(JSON.stringify(bounded)) > 45_000) { bounded.shift(); truncated = true; }
  const raw = maskAgentOfficeCliText(pane.output);
  if (raw.length > 8_000) truncated = true;
  const snapshot = { worker: AGENT_OFFICE_CLI_WORKER,
    source: "amux-codex-rollout", capturedAt: now.toISOString(), truncated,
    events: bounded, rawOutput: raw.slice(-8_000) };
  while (Buffer.byteLength(JSON.stringify(snapshot)) > 65_536 && snapshot.events.length) {
    snapshot.events.shift(); snapshot.truncated = true;
  }
  return agentOfficeCliSnapshotSchema.parse(snapshot);
}

export async function collectAgentOfficeCliSnapshot(read = readAgentOfficeCliSource) {
  const [transcript, pane] = await Promise.all([read("transcript"), read("pane")]);
  return projectAgentOfficeCliSource(transcript, pane);
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
