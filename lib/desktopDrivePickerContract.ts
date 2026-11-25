import { z } from "zod";
import { CHAT_MAX_ATTACHMENTS_PER_MESSAGE } from "./chatAttachmentLimits";

export const DESKTOP_DRIVE_PAGE = "/auth/desktop/drive-picker";
export const DESKTOP_DRIVE_CALLBACK = "/desktop-drive/callback";
const base64url = /^[A-Za-z0-9_-]+$/;
const publicKey = z.string().length(87).regex(base64url);
const state = z.string().length(43).regex(base64url);
export const googleDriveTypes = [
  "application/vnd.google-apps.document",
  "application/vnd.google-apps.spreadsheet",
  "application/vnd.google-apps.presentation",
] as const;

export const desktopDriveLink = z.object({
  port: z.coerce.number().int().min(1024).max(65535),
  state,
  key: publicKey,
  slots: z.coerce.number().int().min(1).max(CHAT_MAX_ATTACHMENTS_PER_MESSAGE),
}).strict();

const driveFile = z.object({
  id: z.string().min(1).max(256).regex(base64url),
  name: z.string().trim().min(1).max(120),
  mimeType: z.enum(googleDriveTypes),
}).strict();

export const driveSelection = z.object({
  accessToken: z.string().min(1).max(4096),
  files: z.array(driveFile).min(1).max(CHAT_MAX_ATTACHMENTS_PER_MESSAGE),
}).strict();
export type DriveSelection = z.infer<typeof driveSelection>;

export const desktopDriveResult = z.object({
  state,
  key: publicKey,
  iv: z.string().length(16).regex(base64url),
  payload: z.string().min(22).max(18000).regex(base64url),
}).strict();

export function driveEncode(bytes: Uint8Array) {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function driveDecode(value: string) {
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (byte) => byte.charCodeAt(0));
}

const curve = { name: "ECDH", namedCurve: "P-256" };

export async function driveKeyPair() {
  const pair = await crypto.subtle.generateKey(curve, false, ["deriveKey"]);
  const key = driveEncode(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  return { key, privateKey: pair.privateKey };
}

export async function driveCipher(privateKey: CryptoKey, encoded: string) {
  const publicKey = await crypto.subtle.importKey("raw", driveDecode(encoded), curve, false, []);
  return crypto.subtle.deriveKey({ name: "ECDH", public: publicKey }, privateKey, { name: "AES-GCM", length: 256 },
    false, ["encrypt", "decrypt"]);
}

export function driveProof(state: string, iv: Uint8Array<ArrayBuffer>) {
  return { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(state) };
}
