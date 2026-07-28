"use client";

/**
 * The pieces every Turnstile caller needs before it can render a widget: the
 * `window.turnstile` shape, the one-time script load, and the local-development
 * bypass rule. Kept in its own module so the chat page's verification
 * coordinator and the standalone forms (sign-in, support) share exactly one
 * script tag and one definition of "this host does not run Turnstile".
 *
 * Nothing here decides *whether* verification is required -- that is always the
 * server's call (lib/turnstile.ts).
 */

export type TurnstileWidgetSize = "normal" | "flexible" | "compact";

export type TurnstileApi = {
  render: (container: HTMLElement, options: Record<string, unknown>) => string;
  execute: (widgetId: string) => void;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_ID = "cloudflare-turnstile-script";
const SCRIPT_URL =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

export const isLocalTurnstileBypassHost = () => {
  if (process.env.NODE_ENV === "production") return false;
  if (typeof window === "undefined") return false;
  return ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
};

export const loadTurnstile = () =>
  new Promise<void>((resolve, reject) => {
    if (window.turnstile) {
      resolve();
      return;
    }
    const existing = document.getElementById(
      SCRIPT_ID
    ) as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener(
        "error",
        () => reject(new Error("Turnstile failed to load.")),
        { once: true }
      );
      return;
    }

    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.src = SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener(
      "error",
      () => reject(new Error("Turnstile failed to load.")),
      { once: true }
    );
    document.head.appendChild(script);
  });
