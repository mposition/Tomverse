"use client";

import { signOut } from "next-auth/react";
import { useRef, useState } from "react";
import { DESKTOP_AUTH_CLIENT, DESKTOP_AUTH_VALUE, isDesktopRedirect } from "@/lib/desktopAuthContract";

export function DesktopLoginContent({ account, ...context }: {
  account?: string | null;
  clientId: typeof DESKTOP_AUTH_CLIENT;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}) {
  const inFlight = useRef(false);
  const [phase, setPhase] = useState<"idle" | "loading" | "failed">("idle");

  async function connect() {
    if (inFlight.current || !isDesktopRedirect(context.redirectUri)) return;
    inFlight.current = true;
    setPhase("loading");
    try {
      const response = await fetch("/api/auth/desktop/login-grant", {
        method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", redirect: "error",
        body: JSON.stringify({ ...context, codeChallengeMethod: "S256" }),
      });
      const result = await response.json();
      if (!response.ok || typeof result.grant !== "string" || !DESKTOP_AUTH_VALUE.test(result.grant)) throw Error("Grant refused.");
      const callback = new URL(context.redirectUri);
      callback.search = new URLSearchParams({ grant: result.grant, state: context.state }).toString();
      const link = document.createElement("a");
      link.referrerPolicy = "no-referrer";
      link.href = callback.href;
      link.click();
    } catch {
      inFlight.current = false;
      setPhase("failed");
    }
  }

  return <main className="mx-auto flex min-h-[60dvh] max-w-md flex-col justify-center gap-5 p-8">
    <h1 className="text-2xl font-semibold">Connect Tomverse Desktop</h1>
    {account && <p>{account}</p>}
    <button type="button" className="rounded-lg bg-blue-600 px-4 py-3 text-white disabled:opacity-60"
      disabled={phase === "loading"} onClick={() => void connect()}>
      {phase === "loading" ? "Connecting…" : "Continue in Desktop"}
    </button>
    <button type="button" className="text-sm underline underline-offset-4 disabled:opacity-60" disabled={phase === "loading"}
      onClick={() => void signOut({ callbackUrl: window.location.pathname + window.location.search })}>
      Use another account
    </button>
    {phase === "failed" && <p role="alert">Could not connect. Restart sign-in in Tomverse Desktop.</p>}
  </main>;
}
