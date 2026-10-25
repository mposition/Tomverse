import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { readLimitedJson } from "@/lib/apiSecurity";
import { agentOfficeCliBuffer } from "@/lib/agentOfficeCliMonitorBuffer";
import { AGENT_OFFICE_CLI_MAX_BYTES, agentOfficeCliSnapshotSchema } from "@/lib/agentOfficeCliMonitorCore";

export function agentOfficeCliMonitorCredential(env = process.env): string | null {
  const secret = env.TOMVERSE_AMUX_CLI_MONITOR_SECRET ?? "";
  return env.TOMVERSE_AMUX_CLI_MONITOR === "1" && secret.length >= 32
    ? createHash("sha256").update(secret).digest("hex") : null;
}

export async function recordAgentOfficeCliMonitor(request: Request) {
  const credential = agentOfficeCliMonitorCredential();
  const provided = request.headers.get("authorization") ?? "";
  const digest = createHash("sha256").update(provided.startsWith("Bearer ") ? provided.slice(7) : "").digest();
  if (!credential || !timingSafeEqual(digest, Buffer.from(credential, "hex")))
    return { status: 401, body: { error: "unauthorized" } };
  const snapshot = await readLimitedJson(request, AGENT_OFFICE_CLI_MAX_BYTES, agentOfficeCliSnapshotSchema);
  const age = Date.now() - Date.parse(snapshot.capturedAt);
  if (age < -30_000 || age > 60_000) return { status: 400, body: { error: "expired_capture" } };
  const result = agentOfficeCliBuffer.record(snapshot, credential);
  return { status: result === "older" ? 409 : 200, body: { result } };
}
