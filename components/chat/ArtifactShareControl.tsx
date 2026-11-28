"use client";

import { ApiClientError, createApiClient } from "@tomverse/api-client";
import { Link2, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { useLanguage } from "@/components/LanguageProvider";
import { artifactWorkspaceCopy, formatArtifactWorkspaceCopy } from "@/locales/artifactWorkspace";

/**
 * The Share button in the preview panel, and the small card it opens: make a
 * public read-only link, or -- once there is one -- its address, expiry and a
 * way to stop it.
 *
 * Policy: docs/policy/generated-artifacts.md section 19. It renders nothing
 * until the server says sharing is on (or that a link already exists, so its
 * owner can still stop it): a guest, a signed-out page and a switched-off
 * feature all see no button. What is published is the source as the answer
 * made it, read on the server; the panel's edits are never sent.
 */

export type ArtifactShareSource =
  | { kind: "artifact"; artifactId: string }
  | { kind: "code_block"; messageId: string; language: string; code: string };

type ShareView = { id: string; url: string; createdAt: string; expiresAt: string };
type Status = { enabled: boolean; ttlDays: number; share: ShareView | null };

const api = () => createApiClient(fetch);

/** Same normalisation and hash the server keys a code block's link on (lib/artifactShareService.ts). */
const sha256Hex = async (text: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text.replace(/\r\n?/g, "\n")));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const statusPath = async (source: ArtifactShareSource) =>
  source.kind === "artifact"
    ? `/api/artifact-shares?artifactId=${encodeURIComponent(source.artifactId)}`
    : `/api/artifact-shares?messageId=${encodeURIComponent(source.messageId)}&contentHash=${await sha256Hex(source.code)}`;

const button =
  "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-2.5 text-xs font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-generated-artifact-500 disabled:opacity-60";

export function ArtifactShareControl({ source, edited }: { source: ArtifactShareSource; edited: boolean }) {
  const { lang } = useLanguage();
  const copy = artifactWorkspaceCopy[lang].share;
  const sourceKey = source.kind === "artifact" ? `a:${source.artifactId}` : `c:${source.messageId}:${source.code}`;
  // Keyed by source, so a status read for another source is never shown for this one.
  const [loaded, setLoaded] = useState<{ key: string; status: Status } | null>(null);
  const status = loaded?.key === sourceKey ? loaded.status : null;
  const setStatus = (next: Status) => setLoaded({ key: sourceKey, status: next });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await api().json<Status>(await statusPath(source));
        if (!cancelled) setLoaded({ key: sourceKey, status: next });
      } catch {
        // Signed out, a guest, an unsaved answer, or no crypto: no button.
      }
    })();
    return () => {
      cancelled = true;
    };
    // `sourceKey` stands for `source`, whose object identity changes on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey]);

  if (!status || (!status.enabled && !status.share)) return null;
  const share = status.share;

  const errorText = (error: unknown) => {
    const code = error instanceof ApiClientError ? error.code : "";
    if (error instanceof ApiClientError && error.status === 429) return copy.errors.RATE_LIMITED;
    return (copy.errors as Record<string, string>)[code] ?? copy.errors.generic;
  };

  const create = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await api().json<{ share: ShareView }>("/api/artifact-shares", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source }),
      });
      setStatus({ ...status, share: result.share });
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (!share) return;
    setBusy(true);
    setMessage(null);
    try {
      await api().json(`/api/artifact-shares/${encodeURIComponent(share.id)}`, { method: "DELETE" });
      setStatus({ ...status, share: null });
      setMessage(copy.revoked);
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const copyLink = async () => {
    if (!share) return;
    try {
      await navigator.clipboard.writeText(share.url);
      setMessage(copy.linkCopied);
    } catch {
      setMessage(copy.errors.generic);
    }
  };

  const expires = share
    ? formatArtifactWorkspaceCopy(copy.expires, {
        date: new Intl.DateTimeFormat(lang, { dateStyle: "medium" }).format(new Date(share.expiresAt)),
      })
    : null;

  return (
    // Not positioned itself: the card below is placed against the panel's toolbar, so it stays on screen wherever the button wraps.
    <div>
      <button
        type="button"
        data-testid="artifact-share-button"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
          setMessage(null);
        }}
        className={`${button} ${share ? "bg-accent-generated-artifact-100 text-accent-generated-artifact-800 dark:bg-accent-generated-artifact-900/60 dark:text-accent-generated-artifact-100" : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"}`}
      >
        <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
        {share ? copy.shared : copy.button}
      </button>
      {open && (
        <div
          role="group"
          aria-label={copy.dialogTitle}
          data-testid="artifact-share-card"
          className="absolute inset-x-2 top-full z-10 mt-1 rounded-xl sm:left-auto sm:w-[22rem] border border-zinc-200 bg-white p-3 text-sm text-zinc-700 shadow-lg dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
        >
          <p className="font-bold text-zinc-900 dark:text-zinc-50">{copy.dialogTitle}</p>
          {share ? (
            <>
              <label htmlFor="artifact-share-url" className="mt-2 block text-xs font-bold text-zinc-500 dark:text-zinc-400">{copy.linkLabel}</label>
              <input
                id="artifact-share-url"
                data-testid="artifact-share-url"
                readOnly
                value={share.url}
                onFocus={(event) => event.currentTarget.select()}
                className="mt-1 min-h-11 w-full rounded-lg border border-zinc-300 bg-zinc-50 px-2 font-mono text-base text-zinc-800 md:text-xs dark:border-zinc-600 dark:bg-zinc-950 dark:text-zinc-100"
              />
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400" data-testid="artifact-share-expires">{expires}</p>
              <div className="mt-2 flex flex-wrap justify-end gap-2">
                <button type="button" data-testid="artifact-share-copy" onClick={() => void copyLink()} className={`${button} border border-zinc-300 dark:border-zinc-600`}>
                  {copy.copyLink}
                </button>
                <button type="button" data-testid="artifact-share-revoke" disabled={busy} onClick={() => void revoke()} className={`${button} border border-red-300 text-red-700 dark:border-red-800 dark:text-red-300`}>
                  {busy && <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                  {busy ? copy.revoking : copy.revoke}
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="mt-1">{copy.dialogBody}</p>
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{formatArtifactWorkspaceCopy(copy.dialogSnapshot, { days: status.ttlDays })}</p>
              {edited && <p data-testid="artifact-share-edited-note" className="mt-1 text-xs font-semibold text-amber-700 dark:text-amber-300">{copy.dialogEditedNote}</p>}
              <div className="mt-2 flex flex-wrap justify-end gap-2">
                <button type="button" onClick={() => setOpen(false)} className={`${button} text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800`}>
                  {copy.cancel}
                </button>
                <button
                  type="button"
                  data-testid="artifact-share-create"
                  disabled={busy || !status.enabled}
                  onClick={() => void create()}
                  className={`${button} bg-accent-generated-artifact-600 text-white hover:bg-accent-generated-artifact-700`}
                >
                  {busy && <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                  {busy ? copy.creating : copy.create}
                </button>
              </div>
            </>
          )}
          {message && <p role="status" data-testid="artifact-share-message" className="mt-2 text-xs font-semibold">{message}</p>}
        </div>
      )}
    </div>
  );
}
