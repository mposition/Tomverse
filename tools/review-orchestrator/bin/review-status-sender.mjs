#!/usr/bin/env node
/**
 * Sends the review server's status snapshot to the Tomverse app's Agent office.
 *
 * Runs as its own account (deploy/review-status-sender.service, systemd
 * DynamicUser), never as the review account: it holds the bearer secret, and
 * every reviewer CLI runs as the review account (lib/status-report.mjs says
 * why that matters). It reads no review configuration, no job and no reviewer
 * output -- only the snapshot file the daemon writes.
 *
 * Environment:
 *   REVIEW_ORCHESTRATOR_STATUS_SECRET   bearer secret, 32+ characters
 *   REVIEW_STATUS_URL                   https URL of the app's status route
 *   REVIEW_STATUS_SNAPSHOT              absolute path of the daemon's snapshot.json
 *   REVIEW_STATUS_INTERVAL_SECONDS      optional, 30-3600, default 60
 *
 * Exit 64 when the settings cannot run; otherwise it runs until stopped.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createStatusSender, statusSenderSettings } from "../lib/status-report.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const log = (line) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);
  const settings = statusSenderSettings(process.env);
  if (settings.error) {
    log(`status sender not started: ${settings.error}`);
    return 64;
  }
  // Nothing to finish on stop: a report in flight is just not delivered.
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
  const sender = createStatusSender({ settings, log });
  log("status sender started");
  for (;;) {
    await sender.sendOnce();
    await sleep(settings.intervalSeconds * 1000);
  }
}

const isEntry = (() => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isEntry) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`status sender failed: ${error.message}\n`);
      process.exit(65);
    },
  );
}
