import { posix } from "node:path";

export type AmuxTrackedCheckoutCliPlan = {
  binary: "/run/amux-cli/claude";
  cwd: string;
  args: readonly string[];
};

const MODEL_ID = /^claude-[A-Za-z0-9._-]{1,120}$/;
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);
const CHECKOUT = /^\/tmp\/amux-v19-checkout-[A-Za-z0-9]{6}$/;
const READ_TOOLS = "Read,Grep,Glob";

/** A fixed, file-tool-only invocation for a prepared v19 checkout. The caller
 * must separately prove the mount, credential boundary, selected model and
 * monthly reservation before spawning a CLI. Codex currently has no equivalent
 * file-only tool surface and therefore has no direct-read invocation here. */
export function planAmuxTrackedCheckoutClaudeCli(input: {
  directory: string;
  modelId: string;
  reasoningEffort: string;
}): AmuxTrackedCheckoutCliPlan {
  if (!input || typeof input !== "object" ||
      typeof input.directory !== "string" || !CHECKOUT.test(input.directory) ||
      posix.normalize(input.directory) !== input.directory ||
      typeof input.modelId !== "string" || !MODEL_ID.test(input.modelId) ||
      !EFFORTS.has(input.reasoningEffort)) {
    throw new TypeError("invalid tracked checkout CLI selection");
  }
  return Object.freeze({
    binary: "/run/amux-cli/claude" as const,
    cwd: input.directory,
    args: Object.freeze([
      "--print", "--bare", "--safe-mode", "--restricted",
      "--disable-slash-commands", "--no-chrome",
      "--no-session-persistence", "--strict-mcp-config",
      "--output-format", "stream-json", "--verbose",
      "--permission-mode", "dontAsk", "--permission-prompts", "none",
      "--tools", READ_TOOLS, "--allowedTools", READ_TOOLS,
      "--model", input.modelId, "--effort", input.reasoningEffort,
    ]),
  });
}
