import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AMUX_SESSION_INTAKE_ORIGIN_ENV,
  amuxSessionIntakeEndpoint,
  isAmuxSessionIntakeClientSecret,
  prepareAmuxSessionIntakeSubmission,
  readAmuxSessionIntakeClientRequest,
  submitAmuxSessionIntakeClientRequest,
} from "../lib/amux/ideaSessionIntakeClientCore.ts";
import { AMUX_SESSION_INTAKE_CLIENT_SECRET_ENV } from
  "../lib/amux/ideaSessionIntakeReadbackCore.ts";

/**
 * Fixed repository client for coding-tool sessions.
 *
 *   npm run local:amux-session-intake -- submit [--origin https://...] [--input file|-]
 *   npm run local:amux-session-intake -- readback --request-id <uuid> [--origin https://...]
 *
 * Submit input is one JSON object on stdin by default. The client prints its
 * generated request ID before the sole POST, then prints closed metadata only.
 */

const parseArgs = (args) => {
  const command = args[0];
  const allowed = command === "submit"
    ? new Set(["--origin", "--input"])
    : command === "readback"
      ? new Set(["--origin", "--request-id"])
      : null;
  if (!allowed) throw new Error("command_invalid");
  const flags = {};
  for (let index = 1; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!allowed.has(name) || value === undefined || value.startsWith("--") ||
        Object.hasOwn(flags, name)) throw new Error("command_invalid");
    flags[name] = value;
  }
  return { command, flags };
};

const print = (value) => new Promise((resolve, reject) => {
  process.stdout.write(`${JSON.stringify(value)}\n`, (error) => {
    if (error) reject(error);
    else resolve();
  });
});

const CLOSED_CLIENT_ERRORS = new Set([
  "client_failed",
  "command_invalid",
  "credential_unavailable",
  "origin_invalid",
  "request_id_invalid",
  "input_unavailable",
  "schema_rejected",
  "content_refused",
  "metadata_incomplete",
]);

const closedErrorCode = (error) =>
  error instanceof Error && CLOSED_CLIENT_ERRORS.has(error.message)
    ? error.message
    : "client_failed";

export async function runAmuxSessionIntakeClient(
  args,
  env = process.env,
  dependencies = {},
) {
  const { command, flags } = parseArgs(args);
  const secret = env[AMUX_SESSION_INTAKE_CLIENT_SECRET_ENV];
  if (!isAmuxSessionIntakeClientSecret(secret)) {
    throw new Error("credential_unavailable");
  }
  const endpoint = amuxSessionIntakeEndpoint(
    flags["--origin"] ?? env[AMUX_SESSION_INTAKE_ORIGIN_ENV] ?? "",
  );
  const fetcher = dependencies.fetcher;
  if (command === "readback") {
    const requestId = flags["--request-id"];
    if (!requestId) throw new Error("request_id_invalid");
    return readAmuxSessionIntakeClientRequest({ endpoint, secret, requestId, fetcher });
  }
  const inputPath = flags["--input"] ?? "-";
  let inputText;
  try {
    inputText = dependencies.readInput
      ? dependencies.readInput(inputPath)
      : readFileSync(inputPath === "-" ? 0 : inputPath, "utf8");
  } catch {
    throw new Error("input_unavailable");
  }
  let input;
  try {
    input = JSON.parse(inputText);
  } catch {
    throw new Error("schema_rejected");
  }
  const inspected = prepareAmuxSessionIntakeSubmission(
    input,
    dependencies.createRequestId,
  );
  await (dependencies.onPrepared ?? print)({
    status: "dispatching",
    requestId: inspected.requestId,
  });
  return submitAmuxSessionIntakeClientRequest({ endpoint, secret, inspected, fetcher });
}

async function main() {
  try {
    const result = await runAmuxSessionIntakeClient(process.argv.slice(2));
    await print(result);
    process.exitCode = result.state === "committed" ? 0
      : result.state === "refused" ? 2 : 3;
  } catch (error) {
    console.error(closedErrorCode(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
