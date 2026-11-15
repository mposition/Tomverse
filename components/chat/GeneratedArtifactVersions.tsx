"use client";

import { useEffect, useRef, useState } from "react";
import { useLanguage } from "@/components/LanguageProvider";
import { useArtifactRevisionAction } from "@/components/chat/GeneratedArtifactRevisionContext";
import { artifactDownloadPath, type ChatStreamArtifact } from "@/lib/generatedArtifactCore";
import { isGeneratedArtifactRevisionSupported } from "@/lib/generatedArtifactRevisionCore";
import { artifactVersionsPath, mergeGeneratedArtifactVersions, parseGeneratedArtifactVersions,
  type GeneratedArtifactVersion } from "@/lib/generatedArtifactVersions";
import { saveResponseAsFile } from "@/lib/browserDownload";
import { discardResponseBody } from "@/lib/discardResponseBody";

/** A bounded view of real parent relationships, with the same explicit file actions. */
export function GeneratedArtifactVersions({ artifact }: { artifact: ChatStreamArtifact }) {
  const { t, lang } = useLanguage();
  const revise = useArtifactRevisionAction();
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<GeneratedArtifactVersion[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  const load = async (nextCursor: string | null) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(artifactVersionsPath(artifact.id, nextCursor), {
        cache: "no-store", signal: controller.signal,
      });
      if (!response.ok) {
        await discardResponseBody(response);
        if (!controller.signal.aborted) setError(t(response.status === 423
          ? "chat.artifactDownloadLocked" : "chat.artifactVersionsFailed"));
        return;
      }
      const parsed = parseGeneratedArtifactVersions(await response.json());
      if (controller.signal.aborted) return;
      if (!parsed) { setError(t("chat.artifactVersionsFailed")); return; }
      setVersions(current => nextCursor ? mergeGeneratedArtifactVersions(current, parsed.artifacts) : parsed.artifacts);
      setCursor(parsed.nextCursor);
    } catch {
      if (!controller.signal.aborted) setError(t("chat.artifactVersionsFailed"));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };

  const download = async (version: GeneratedArtifactVersion) => {
    setBusy(version.id);
    setError(null);
    try {
      const response = await fetch(artifactDownloadPath(version.id), { cache: "no-store" });
      if (!response.ok) { await discardResponseBody(response); throw new Error("Download refused"); }
      await saveResponseAsFile(response, version.filename);
    } catch { setError(t("chat.artifactDownloadFailed")); }
    finally { setBusy(null); }
  };

  const names = new Map(versions.map(item => [item.id, item.filename]));
  const rowId = (id: string) => `file-version-${artifact.id}-${id}`;
  return <div className="w-full min-w-0 basis-full" data-testid="generated-artifact-versions">
    <button type="button" data-testid="generated-artifact-versions-toggle" aria-expanded={open}
      className="min-h-11 rounded-lg px-2 text-sm font-semibold text-accent-generated-artifact-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-generated-artifact-500 dark:text-accent-generated-artifact-200"
      onClick={() => {
        if (open) { request.current?.abort(); setLoading(false); setOpen(false); }
        else { setOpen(true); void load(null); }
      }}>{t("chat.artifactVersions")}</button>
    {open && <div className="mt-1 min-w-0" aria-label={t("chat.artifactVersions")}>
      <ul className="space-y-2" data-testid="generated-artifact-version-list">
        {versions.map(version => <li key={version.id} id={rowId(version.id)} tabIndex={-1} data-testid="generated-artifact-version"
          data-artifact-id={version.id} data-parent-artifact-id={version.parentArtifactId ?? ""}
          className="min-w-0 rounded-lg border border-zinc-200 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent-generated-artifact-500 dark:border-zinc-700">
          <p className="break-words font-semibold">{version.filename}
            {version.id === artifact.id && <span className="ml-2 font-normal text-zinc-500">{t("chat.artifactVersionCurrent")}</span>}</p>
          <p className="break-words text-xs text-zinc-500 dark:text-zinc-400">
            {version.parentArtifactId ? <button type="button" data-testid="generated-artifact-version-parent"
              disabled={!names.has(version.parentArtifactId)}
              className="min-h-11 rounded-lg text-left underline decoration-dotted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-generated-artifact-500 disabled:no-underline"
              onClick={() => {
                const target = document.getElementById(rowId(version.parentArtifactId!));
                target?.scrollIntoView({ block: "nearest", behavior: "auto" });
                target?.focus({ preventScroll: true });
              }}>{t("chat.artifactVersionFrom").replaceAll("{filename}",
                names.get(version.parentArtifactId) ?? t("chat.artifactVersionEarlier"))}</button>
              : t(version.lineageId === version.id ? "chat.artifactVersionOriginal" : "chat.artifactVersionSourceRemoved")}
            {" · "}<time dateTime={version.createdAt}>{new Date(version.createdAt).toLocaleString(lang)}</time>
          </p>
          <div className="mt-1 flex flex-wrap gap-2">
            <button type="button" className="min-h-11 rounded-lg border border-zinc-300 px-3 dark:border-zinc-600"
              disabled={busy !== null} onClick={() => void download(version)}>{t("chat.artifactDownload")}</button>
            {revise && isGeneratedArtifactRevisionSupported(version) && <button type="button"
              data-testid="generated-artifact-version-revise" disabled={busy !== null}
              className="min-h-11 rounded-lg border border-accent-generated-artifact-300 px-3 dark:border-accent-generated-artifact-700"
              onClick={() => {
                setBusy(version.id); setError(null);
                void revise(version).then(setError).finally(() => setBusy(null));
              }}>{t("chat.artifactRevise")}</button>}
          </div>
        </li>)}
      </ul>
      {loading && <p role="status" className="text-sm">{t("chat.artifactVersionsLoading")}</p>}
      {error && <p role="alert" data-testid="generated-artifact-versions-error" className="text-sm text-red-600 dark:text-red-300">{error}</p>}
      {!loading && (cursor || error) && <button type="button" className="min-h-11 rounded-lg px-2 text-sm font-semibold"
        onClick={() => void load(cursor)}>{t(error ? "chat.artifactVersionsRetry" : "chat.artifactVersionsMore")}</button>}
    </div>}
  </div>;
}
