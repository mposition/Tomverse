import { z } from "zod";

const connectionId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const toolName = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const version = z.number().int().positive();

export const desktopMcpAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("list") }).strict(),
  z.object({ type: z.literal("call"), version, name: toolName, args: z.record(z.string(), z.unknown()) }).strict(),
]);
export const desktopMcpRequest = z.object({ connectionId, action: desktopMcpAction }).strict();
export const desktopMcpReply = z.discriminatedUnion("type", [
  z.object({ type: z.literal("list"), version, tools: z.array(z.object({
    name: toolName, inputSchema: z.record(z.string(), z.unknown()),
  }).strict()).max(32) }).strict(),
  z.object({ type: z.literal("result"), status: z.enum(["ok", "no_results", "server_error"]),
    content: z.string().max(8_192), sources: z.array(z.object({
      url: z.string().max(2_048), title: z.string().max(1_024).optional(), sourceProvider: z.string().max(80),
    })).max(32),
  }).strict(),
]);
export type DesktopMcpAction = z.infer<typeof desktopMcpAction>;
export type DesktopMcpReply = z.infer<typeof desktopMcpReply>;
