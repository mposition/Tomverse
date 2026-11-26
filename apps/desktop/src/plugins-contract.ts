import { z } from "zod";

/**
 * Plugins on this computer (a plugin brings skills, commands, agent definitions, hooks and MCP servers in one folder) and the
 * marketplaces they come from. The window sends one of these typed commands and never a path: the folder to install from is chosen in
 * a dialog the main process opens. A plugin is third-party code, so an install or update is two steps: a preview (what it holds,
 * including every command a hook or server would run) and a confirmation of that exact preview. Nothing of a plugin runs until its
 * hooks and servers are approved in the local extensions list.
 */

const pluginName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const previewId = z.string().regex(/^[0-9a-f]{16}$/);

export const pluginsCommand = z.discriminatedUnion("type", [
  z.object({ type: z.literal("list") }).strict(),
  z.object({ type: z.literal("preview-folder") }).strict(),
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
  /** Where it comes from, for display: a folder name, or `plugin@marketplace`. */
  from: string;
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
  from: { kind: "folder" } | { kind: "marketplace"; marketplace: string };
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
export type MarketplaceView = { name: string; location: string; commit?: string; entries: MarketplaceEntryView[]; problem?: string };

export type PluginsNotice = {
  code: "installed" | "updated" | "up-to-date" | "removed" | "marketplace-added" | "marketplace-updated" | "marketplace-removed" | "cancelled";
  name?: string;
};

export type PluginsView = {
  /** False while no project is open: the per-project switch is unavailable then. */
  project: boolean;
  plugins: InstalledPluginView[];
  marketplaces: MarketplaceView[];
  preview?: PluginPreview;
  notice?: PluginsNotice;
  /** A refusal, in plain words (a link that leaves the folder, a download that failed ...). */
  error?: string;
};
