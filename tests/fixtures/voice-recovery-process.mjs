// A real child process with a local-only provider socket and the actual recovery/database code.
import { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import WebSocket from "ws";
const mod = path => pathToFileURL(resolve(path)).href;
const endpoint = new URL(process.env.VOICE_FIXTURE_SOCKET);
if (endpoint.protocol !== "ws:" || endpoint.hostname !== "127.0.0.1") throw Error("Only the loopback fixture is allowed.");
mock.module(mod("lib/voiceConversationProvider.ts"), { namedExports: {
  attachVoiceProviderSession: () => new WebSocket(endpoint),
  closeVoiceProviderSession: async () => null,
  hangupVoiceProviderSession: async () => {},
} });
mock.module(mod("lib/billingEntitlements.ts"), { namedExports: { getUserBillingPlan: async () => ({ monthlyMessageLimit: 300, dailyMessageLimit: 300 }) } });
const recovery = await import(mod("lib/voiceConversationRecovery.ts"));
if (process.env.VOICE_FIXTURE_MODE === "primary") {
  await recovery.recordVoiceUsage(process.env.VOICE_FIXTURE_ID, 10);
  await recovery.renewVoiceWebLease(process.env.VOICE_FIXTURE_ID);
  process.send({ ready: true });
  setInterval(() => {}, 1000);
} else {
  await recovery.observeActiveVoiceConversations(); process.send({ ready: true });
  let cycle = false;
  setInterval(async () => { if (cycle) return; cycle = true; try { await recovery.observeActiveVoiceConversations(); await recovery.reconcileVoiceConversations(); } finally { cycle = false; } }, 100);
}
