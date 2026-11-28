import { z } from "zod";

const pluginId = z.string().min(1).max(128);
const pluginName = z.string().min(1).max(160);
export const desktopPluginInventory = z.object({
  enabled: z.boolean(),
  servers: z.array(z.object({ id: pluginId, name: pluginName, custom: z.boolean() })).max(512),
  connections: z.array(z.object({
    id: pluginId, serverId: pluginId, name: pluginName, status: z.string().max(48),
    tools: z.number().int().nonnegative(), granted: z.number().int().nonnegative(),
  })).max(512),
});

export type DesktopPluginInventory = z.infer<typeof desktopPluginInventory>;
