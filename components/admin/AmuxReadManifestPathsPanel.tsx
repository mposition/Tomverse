"use client";

import { useRef, useState } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminAmuxIdeaProgressMessages } from "@/lib/adminMessages/amuxIdeaProgress";
import { adminFetch } from "@/lib/adminFetch";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";

type State = "idle" | "loading" | "available" | "missing" |
  "reauth" | "unavailable";

/** Paths are fetched only when the owner asks to see them. Hiding clears the
 * browser component state; the server enforces the original retention clock. */
export function AmuxReadManifestPathsPanel({ ideaId, manifestId,
  fileCount }: { ideaId: string; manifestId: string; fileCount: number }) {
  const m = useAdminMessages(adminAmuxIdeaProgressMessages);
  const [state, setState] = useState<State>("idle");
  const [files, setFiles] = useState<string[]>([]);
  const requestId = useRef(0);

  async function show() {
    const current = ++requestId.current;
    setFiles([]);
    setState("loading");
    try {
      const params = new URLSearchParams({ ideaId, manifestId });
      const response = await adminFetch(
        `/api/admin/amux/ideas/read-manifest?${params}`, { cache: "no-store" });
      if (current !== requestId.current) return;
      if (response.status === 428) { setState("reauth"); return; }
      if (response.status === 404) { setState("missing"); return; }
      if (!response.ok) { setState("unavailable"); return; }
      const body = await response.json();
      if (current !== requestId.current) return;
      if (!body || !body.manifest || !Array.isArray(body.manifest.files) ||
          body.manifest.files.length !== fileCount ||
          !body.manifest.files.every((path: unknown) => typeof path === "string")) {
        setState("unavailable"); return;
      }
      setFiles(body.manifest.files);
      setState("available");
    } catch {
      if (current === requestId.current) setState("unavailable");
    }
  }

  function hide() {
    requestId.current += 1;
    setFiles([]);
    setState("idle");
  }

  return (
    <div className="space-y-2">
      <button type="button" onClick={state === "available" ? hide : show}
        disabled={state === "loading"}
        className="min-h-11 font-medium underline text-blue-200">
        {state === "available" ? m.checkoutReadHidePaths : m.checkoutReadShowPaths}
      </button>
      {state === "loading" ? <p role="status">{m.checkoutReadLoading}</p> : null}
      {state === "missing" ? <p role="status">{m.checkoutReadMissing}</p> : null}
      {state === "unavailable" ? <p role="alert">{m.checkoutReadUnavailable}</p> : null}
      {state === "reauth" ? <a className="block font-medium underline text-blue-200"
        href={adminRecentAuthenticationHref("/admin/amux-backlog?tab=ideas")}>
        {m.signIn}
      </a> : null}
      {state === "available" ? <textarea readOnly rows={10}
        aria-label={m.checkoutReadPathsLabel} value={files.join("\n")}
        className="w-full resize-y rounded border border-zinc-700 bg-zinc-950 p-2 font-mono text-xs text-zinc-100" /> : null}
    </div>
  );
}
