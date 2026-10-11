/**
 * Display-only Ubuntu resident roster, approved in orchestration policy v27.
 * This is not the dispatch catalog and must never authorize registration,
 * claims or execution. Presence here does not prove a running process.
 */
export const AGENT_OFFICE_AMUX_ROSTER = [
  { name: "claude-chore", provider: "anthropic" },
  { name: "claude-contract", provider: "anthropic" },
  { name: "claude-impl", provider: "anthropic" },
  { name: "claude-review", provider: "anthropic" },
  { name: "codex-chore", provider: "openai" },
  { name: "codex-contract", provider: "openai" },
  { name: "codex-impl", provider: "openai" },
  { name: "cursor-chore", provider: "cursor" },
  { name: "cursor-impl", provider: "cursor" },
  { name: "cursor-worker", provider: "cursor" },
  { name: "copilot-chore", provider: "github-copilot" },
  { name: "copilot-impl", provider: "github-copilot" },
  { name: "copilot-worker", provider: "github-copilot" },
] as const;
