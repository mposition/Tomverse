export const DESKTOP_AUTH_CLIENT = "tomverse-desktop";
export const DESKTOP_CALLBACK_PATH = "/desktop-login/callback";
export const DESKTOP_LIVE_ORIGIN = "https://tomverse.app";
export const DESKTOP_AUTH_VALUE = /^[A-Za-z0-9_-]{43}$/;
export const DESKTOP_IDENTITY_PROVIDERS = ["apple", "google", "azure-ad"] as const;
export type DesktopIdentityProvider = typeof DESKTOP_IDENTITY_PROVIDERS[number];

export type DesktopGrantContext = { state: string; redirectUri: string };

export function isDesktopRedirect(value: string): boolean {
  const match = /^http:\/\/127\.0\.0\.1:(\d{4,5})\/desktop-login\/callback$/.exec(value);
  if (!match?.[1]) return false;
  const port = Number(match[1]);
  return port >= 1024 && port <= 65_535 && String(port) === match[1];
}

export function desktopGrantBinding(challenge: string, context: DesktopGrantContext): string {
  return JSON.stringify([DESKTOP_AUTH_CLIENT, context.redirectUri, context.state, challenge]);
}
