import { z } from "zod";

/**
 * Settings > Execution and limits > "Allow control of this PC from other devices" (host/remote-control.ts). The window
 * sends one of these typed commands and nothing else; the main process owns the switch, the account it belongs to and
 * everything sent to the server.
 */
export const remoteControlCommand = z.discriminatedUnion("action", [
  z.object({ action: z.literal("read") }).strict(),
  z.object({ action: z.literal("set"), enabled: z.boolean() }).strict(),
]);
export type RemoteControlCommand = z.infer<typeof remoteControlCommand>;

/**
 * signed_out: no account; off: the switch is off for this account; idle: on, and nothing runs, so nothing is sent;
 * connected: the last report reached the server; unavailable: the server does not offer remote control;
 * error: the last report failed and is being retried later.
 */
export type RemoteControlStatus = "signed_out" | "off" | "idle" | "connected" | "unavailable" | "error";

export type RemoteControlView = {
  enabled: boolean;
  status: RemoteControlStatus;
  /** The page to open on the other device, shown as text (the app opens no browser for it). */
  page: string | null;
};
