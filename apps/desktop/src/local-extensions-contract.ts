import { z } from "zod";

/**
 * MCP servers and hooks that live on this computer (the user's mcp.json, hooks.json and Claude Code settings, and the open
 * project's own .mcp.json and .claude/settings.json), for the Connectors screen and the Code settings. The window sends
 * one of these typed commands; it never sends a path, a command line or an address. A project's server or hook runs only
 * after the person approves it here, and the approval names the definition's hash, so a definition that changed since
 * the list was shown is not approved.
 */

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const serverId = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/);

export const localExtensionsCommand = z.discriminatedUnion("type", [
  z.object({ type: z.literal("list") }).strict(),
  z.object({ type: z.literal("mcp-approve"), id: serverId, hash }).strict(),
  z.object({ type: z.literal("mcp-enable"), id: serverId, enabled: z.boolean() }).strict(),
  z.object({ type: z.literal("mcp-check"), id: serverId }).strict(),
  z.object({ type: z.literal("hook-approve"), hash }).strict(),
  z.object({ type: z.literal("hook-enable"), hash, enabled: z.boolean() }).strict(),
]);
export type LocalExtensionsCommand = z.infer<typeof localExtensionsCommand>;

export type LocalMcpServer = {
  id: string;
  name: string;
  scope: "user" | "project";
  transport: "stdio" | "http" | "unsupported";
  /** The command line or the address (no query), for the person to read before approving. */
  summary: string;
  hash: string;
  state: "ready" | "pending_approval" | "disabled" | "unsupported";
  /** The plugin it came from (its scope is "project": it waits for approval like a project's own). */
  plugin?: string;
};

export type LocalHook = {
  hash: string;
  event: string;
  matcher: string;
  command: string;
  scope: "user" | "project";
  /** The file name the hook came from, never its folder. */
  source: string;
  state: "active" | "pending_approval" | "disabled";
  plugin?: string;
};

export type LocalExtensionsView = {
  /** False while no project is open: only the project's own files are missing then, and nothing is listed. */
  project: boolean;
  mcp: LocalMcpServer[];
  hooks: LocalHook[];
  problems: string[];
  /** The result of a connection check the person asked for in this call. */
  check?: { id: string; state: "connected" | "failed" | "needs_auth"; toolCount: number; detail?: string };
};
