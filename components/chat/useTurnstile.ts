"use client";

import { useCallback, useEffect, useRef } from "react";

type TurnstileApi = {
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

const isLocalDevelopmentHost = () => {
  if (process.env.NODE_ENV === "production") return false;
  if (typeof window === "undefined") return false;
  return ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
};

const loadTurnstile = () =>
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

export function useTurnstile(enabled: boolean) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const pendingRef = useRef<{
    resolve: (token: string) => void;
    reject: (error: Error) => void;
  } | null>(null);

  useEffect(() => {
    const sitekey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    if (!enabled || !sitekey || isLocalDevelopmentHost()) return;
    let cancelled = false;

    void loadTurnstile()
      .then(() => {
        if (
          cancelled ||
          !window.turnstile ||
          !containerRef.current ||
          widgetIdRef.current
        ) {
          return;
        }
        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey,
          action: "guest_chat",
          execution: "execute",
          appearance: "interaction-only",
          theme: "auto",
          "response-field": false,
          callback: (token: string) => {
            pendingRef.current?.resolve(token);
            pendingRef.current = null;
          },
          "error-callback": () => {
            pendingRef.current?.reject(
              new Error("Guest verification failed.")
            );
            pendingRef.current = null;
          },
          "expired-callback": () => {
            pendingRef.current?.reject(
              new Error("Guest verification expired.")
            );
            pendingRef.current = null;
          },
        });
      })
      .catch((error) => {
        pendingRef.current?.reject(
          error instanceof Error ? error : new Error("Turnstile failed.")
        );
        pendingRef.current = null;
      });

    return () => {
      cancelled = true;
      pendingRef.current?.reject(new Error("Guest verification cancelled."));
      pendingRef.current = null;
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
      }
      widgetIdRef.current = null;
    };
  }, [enabled]);

  const getToken = useCallback(async () => {
    if (!enabled) return undefined;
    if (isLocalDevelopmentHost()) return undefined;
    if (!process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY) {
      if (process.env.NODE_ENV !== "production") return undefined;
      throw new Error("Guest verification is not configured.");
    }

    const deadline = Date.now() + 10_000;
    while (!widgetIdRef.current || !window.turnstile) {
      if (Date.now() >= deadline) {
        throw new Error("Guest verification is unavailable.");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    return await new Promise<string>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        pendingRef.current = null;
        reject(new Error("Guest verification timed out."));
      }, 15_000);
      pendingRef.current = {
        resolve: (token) => {
          window.clearTimeout(timeout);
          resolve(token);
        },
        reject: (error) => {
          window.clearTimeout(timeout);
          reject(error);
        },
      };
      window.turnstile!.reset(widgetIdRef.current!);
      window.turnstile!.execute(widgetIdRef.current!);
    });
  }, [enabled]);

  return { containerRef, getToken };
}
