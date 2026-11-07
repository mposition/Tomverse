import "server-only";

import { amuxWorkerChannels, type AmuxWorkerChannel } from "@/lib/adminAmuxFlow";
import { readAmuxWorkerRegistryForAdmin } from "@/lib/amux/workerRegistryAdminRead";

/**
 * Each registered worker's channel for the Execution board's card badges, from
 * the class it was registered with (never from its name). A registry that
 * cannot be read is null: the board then draws no badge rather than a guess.
 * Read only.
 */
export async function readBoardWorkerChannels(): Promise<Record<string, AmuxWorkerChannel> | null> {
  return readAmuxWorkerRegistryForAdmin().then((registry) => amuxWorkerChannels(registry.rows), () => null);
}
