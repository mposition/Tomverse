import { z } from "zod";

/**
 * Plugins on this computer (a plugin brings skills, commands, agent definitions, hooks and MCP servers in one folder) and the
 * marketplaces they come from. The window sends one of these typed commands and never a path: the folder to install from is chosen in
 * a dialog the main process opens (a zip file too). A zip file's address and an npm package are named by the window, and the main
 * process asks the person before it downloads from either, and before it uses their GitHub sign-in for a private repository. These
 * sources, and the marketplace Desktop carries, exist only where the server's switch is on. A plugin is third-party code, so an install or update is two steps: a preview (what it holds,
 * including every command a hook or server would run) and a confirmation of that exact preview. Nothing of a plugin runs until its
 * hooks and servers are approved in the local extensions list.
 */

const pluginName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const previewId = z.string().regex(/^[0-9a-f]{16}$/);
const npmPackage = z.string().regex(/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/).max(214);
const exactVersion = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/).max(100);

export const pluginsCommand = z.discriminatedUnion("type", [
  z.object({ type: z.literal("list") }).strict(),
  z.object({ type: z.literal("preview-folder") }).strict(),
  z.object({ type: z.literal("preview-zip") }).strict(),
  z.object({ type: z.literal("preview-zip-url"), url: z.string().trim().min(1).max(1000) }).strict(),
  z.object({ type: z.literal("preview-npm"), package: npmPackage, version: exactVersion.optional() }).strict(),
  z.object({ type: z.literal("preview-marketplace"), marketplace: pluginName, plugin: pluginName }).strict(),
  z.object({ type: z.literal("preview-update"), name: pluginName }).strict(),
  z.object({ type: z.literal("confirm"), id: previewId }).strict(),
  z.object({ type: z.literal("cancel"), id: previewId }).strict(),
  z.object({ type: z.literal("set-enabled"), name: pluginName, enabled: z.boolean() }).strict(),
  z.object({ type: z.literal("set-enabled-here"), name: pluginName, enabled: z.boolean() }).strict(),
  z.object({ type: z.literal("remove"), name: pluginName }).strict(),
  z.object({ type: z.literal("marketplace-add-folder") }).strict(),
  z.object({ type: z.literal("marketplace-add-git"), url: z.string().trim().min(1).max(500), ref: z.string().trim().max(200).optional() }).strict(),
  z.object({ type: z.literal("marketplace-refresh"), name: pluginName }).strict(),
  z.object({ type: z.literal("marketplace-remove"), name: pluginName }).strict(),
  z.object({ type: z.literal("set-official-marketplace"), enabled: z.boolean() }).strict(),
]);
export type PluginsCommand = z.infer<typeof pluginsCommand>;

export type PluginHookLine = { event: string; matcher: string; command: string; timeoutSec: number };
export type PluginServerLine = { name: string; transport: string; summary: string };

/** What the person confirms. Every hook command and server command is given in full. */
export type PluginPreview = {
  id: string;
  mode: "install" | "update";
  name: string;
  version?: string;
  previousVersion?: string;
  description?: string;
  author?: string;
  /** Where it comes from, for display: a folder name, `plugin@marketplace`, a zip file, an address or an npm package. */
  from: string;
  /** What identifies the files at their source: an npm integrity value, the SHA-256 of a zip file, or a git commit. */
  origin?: { kind: "npm" | "zip" | "zip-url" | "git"; value: string; detail?: string };
  /** The start of the digest that this confirmation covers (the files together with where they came from). */
  approval: string;
  files: number;
  kilobytes: number;
  skills: string[];
  commands: string[];
  agents: string[];
  hooks: PluginHookLine[];
  servers: PluginServerLine[];
  notUsed: string[];
  issues: string[];
  diff?: {
    skillsAdded: string[]; skillsRemoved: string[]; commandsAdded: string[]; commandsRemoved: string[]; agentsAdded: string[]; agentsRemoved: string[];
    hooksAdded: PluginHookLine[]; hooksRemoved: PluginHookLine[];
    serversAdded: PluginServerLine[]; serversRemoved: PluginServerLine[]; serversChanged: Array<{ name: string; from: string; to: string }>;
    needsApproval: boolean;
  };
};

export type InstalledPluginView = {
  name: string;
  version?: string;
  description?: string;
  enabled: boolean;
  /** Off for the open project only. */
  disabledHere: boolean;
  from: { kind: "folder" } | { kind: "zip" } | { kind: "zip-url" } | { kind: "npm"; package: string } | { kind: "marketplace"; marketplace: string };
  skills: string[];
  commands: string[];
  agents: string[];
  hooks: number;
  servers: number;
  /** Hooks and servers that wait for approval (see the local extensions list). */
  pending: number;
  /** The files on disk are not the ones that were installed. */
  modified: boolean;
  readable: boolean;
};

export type MarketplaceEntryView = { name: string; description?: string; version?: string; installed: boolean; supported: boolean };
export type MarketplaceView = { name: string; location: string; commit?: string; entries: MarketplaceEntryView[]; problem?: string; /** The one Desktop carries. */ official?: boolean };

export type PluginsNotice = {
  code: "installed" | "updated" | "up-to-date" | "removed" | "marketplace-added" | "marketplace-updated" | "marketplace-removed" | "cancelled";
  name?: string;
};

export type PluginsView = {
  /** False while no project is open: the per-project switch is unavailable then. */
  project: boolean;
  /** The zip, npm and private-repository sources and the official marketplace are offered (the server's switch is on). */
  sources: boolean;
  /** Whether the marketplace Desktop carries is shown; present only where `sources` is. */
  official?: { enabled: boolean };
  plugins: InstalledPluginView[];
  marketplaces: MarketplaceView[];
  preview?: PluginPreview;
  notice?: PluginsNotice;
  /** A refusal, in plain words (a link that leaves the folder, a download that failed ...). */
  error?: string;
};
