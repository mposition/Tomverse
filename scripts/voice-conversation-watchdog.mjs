import { prisma } from "../lib/prisma.ts";
import { touchVoiceWatchdog, reconcileVoiceConversations, observeActiveVoiceConversations, stopVoiceRecoveryReceivers } from "../lib/voiceConversationRecovery.ts";

if (process.env.VOICE_CONVERSATION_WATCHDOG_ENABLED !== "true" || !process.env.VOICE_CONVERSATION_API_KEY) {
  throw new Error("The voice watchdog requires its explicit switch and dedicated provider credential.");
}
let stopping = false;
let sweep = null;
process.once("SIGINT", () => { stopping = true; });
process.once("SIGTERM", () => { stopping = true; });
// Run independently of the web process. A restart first sweeps persisted rows.
try {
  while (!stopping) {
    try {
      await observeActiveVoiceConversations();
      await touchVoiceWatchdog();
      if (!sweep) sweep = reconcileVoiceConversations(new Date(), 10).catch(() => {}).finally(() => { sweep = null; });
    } catch { process.stderr.write("Voice recovery cycle deferred.\n"); }
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
} finally { await sweep; stopVoiceRecoveryReceivers(); await prisma.$disconnect(); }
