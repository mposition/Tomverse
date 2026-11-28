import { z } from "zod";
import { DESKTOP_IDENTITY_PROVIDERS, type DesktopIdentityProvider } from "../../../lib/desktopAuthContract";
import { isValidLoginEmail, MAX_LOGIN_EMAIL_LENGTH } from "../../../lib/emailValidation";
import type { Snapshot } from "./contract";

const email = z.string().trim().toLowerCase().max(MAX_LOGIN_EMAIL_LENGTH).refine(isValidLoginEmail);
export const desktopLoginEmail = z.discriminatedUnion("action", [
  z.object({ action: z.literal("request"), email }).strict(),
  z.object({ action: z.literal("verify"), email, code: z.string().regex(/^\d{6}$/) }).strict(),
]);
export const desktopIdentityProvider = z.enum(DESKTOP_IDENTITY_PROVIDERS);
export type DesktopLoginEmail = z.infer<typeof desktopLoginEmail>;
export type DesktopEmailResult = { ok: true } | { ok: false; status: "unavailable" | "rejected" | "retry" | "challenge" | "failed"; retryAfter?: number };
export type DesktopLoginState = Pick<Snapshot, "language" | "account">;
export type LoginApi = {
  state(): Promise<DesktopLoginState>;
  subscribe(listener: (state: DesktopLoginState) => void): () => void;
  provider(provider: DesktopIdentityProvider): Promise<void>;
  email(input: DesktopLoginEmail): Promise<DesktopEmailResult>;
  cancel(): Promise<void>;
  quit(): Promise<void>;
};
