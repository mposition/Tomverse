"use client";

import { Loader2, Play, Square, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type RefObject } from "react";

import { useChatArtifactWorkspace, useCodeBlockStreaming } from "@/components/chat/ChatArtifactWorkspaceContext";
import { useLanguage } from "@/components/LanguageProvider";
import {
  CODE_RUN_LIMITS,
  IDLE_CODE_RUN,
  buildCodeRunComposerText,
  buildCodeRunRequest,
  checkCodeRunFileAdd,
  codeRunPlainText,
  parseCodeRunFrameMessage,
  reduceCodeRun,
  sanitizeCodeRunFileName,
  startCodeRun,
  stopCodeRun,
  type CodeRunFrameMessage,
  type CodeRunState,
} from "@/lib/chatCodeRun";
import { CODE_RUN_SANDBOX, buildCodeRunDocument } from "@/lib/chatCodeRunFrame";

/**
 * "Run" on a Python code block, and the result under it.
 *
 * Policy: docs/policy/generated-artifacts.md section 9. The code runs in the
 * user's browser, in a sandboxed frame and a worker (lib/chatCodeRunFrame.ts);
 * nothing goes to the server, so there is no credit to reserve. Nothing runs
 * until the button is pressed, and the frame is not even created until then.
 *
 * What comes back from the frame is untrusted. A message is used only if it
 * came from this frame's window, from the opaque origin a sandboxed frame has,
 * and passes `parseCodeRunFrameMessage`. It is then shown as text, or as a PNG
 * in an `<img>`; none of it is ever HTML.
 */

type ChosenFile = { id: string; name: string; size: number; data: ArrayBuffer };

type Action =
  | { type: "start"; runId: string }
  | { type: "message"; message: CodeRunFrameMessage }
  | { type: "stop"; outcome: "stopped" | "timeout" }
  | { type: "reset" };

const reducer = (state: CodeRunState, action: Action): CodeRunState => {
  switch (action.type) {
    case "start":
      return startCodeRun(action.runId);
    case "message":
      return reduceCodeRun(state, action.message);
    case "stop":
      return stopCodeRun(state, action.outcome);
    case "reset":
      return IDLE_CODE_RUN;
  }
};

const randomId = () => {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

/** How long the page waits for a frame that has gone quiet before it ends the run itself. */
const FRAME_SILENCE_MS = CODE_RUN_LIMITS.loadTimeoutMs + CODE_RUN_LIMITS.runTimeoutMs + 15_000;

const megabytes = (bytes: number) => String(Math.round(bytes / (1024 * 1024)));

/**
 * Whether a chosen file may join the ones already chosen, and what the list is then. A file with the name of one
 * already there replaces it, so the old one is set aside first and the limits are checked against what would remain.
 * A refusal changes nothing: the list comes back as it was, the old file still in it.
 */
export function planCodeRunFileAdd<T extends { name: string; size: number }>(
  existing: readonly T[],
  added: T
): { ok: true; files: T[] } | { ok: false; reason: "count" | "size" | "total"; files: T[] } {
  const rest = existing.filter((file) => file.name !== added.name);
  const refusal = checkCodeRunFileAdd(rest, added);
  return refusal ? { ok: false, reason: refusal, files: [...existing] } : { ok: true, files: [...rest, added] };
}

export function CodeBlockRun({ preRef }: { preRef: RefObject<HTMLPreElement | null> }) {
  const { t } = useLanguage();
  const workspace = useChatArtifactWorkspace();
  const streaming = useCodeBlockStreaming();
  const [state, dispatch] = useReducer(reducer, IDLE_CODE_RUN);
  // One frame per "session": created by the first Run, replaced by Stop, gone when the result is hidden.
  const [frame, setFrame] = useState<{ token: string; nonce: string | null } | null>(null);
  const [files, setFiles] = useState<ChosenFile[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const readyRef = useRef(false);
  const pendingRef = useRef<{ runId: string; code: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const newFrame = useCallback(() => {
    readyRef.current = false;
    // The embedding page's CSP nonce, if it has one: an inline script in the frame needs it (see HtmlArtifactPreviewFrame).
    const nonce = document.querySelector<HTMLScriptElement>("script[nonce]")?.nonce || null;
    setFrame({ token: randomId(), nonce });
  }, []);

  const post = useCallback((runId: string, code: string) => {
    const target = iframeRef.current?.contentWindow;
    if (!target || !frame) return;
    // Copies, so the chosen files stay available for the next run; the copies are what is transferred.
    const copies = files.map((file) => ({ name: file.name, data: file.data.slice(0) }));
    // "*" because a sandboxed frame's origin is opaque and cannot be named; `target` is this frame's own window.
    target.postMessage(buildCodeRunRequest({ token: frame.token, runId, code, files: copies }), "*", copies.map((file) => file.data));
  }, [frame, files]);

  // Messages from the frame.
  useEffect(() => {
    if (!frame) return;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow || event.origin !== "null") return;
      const message = parseCodeRunFrameMessage(event.data, { token: frame.token });
      if (!message) return;
      if (message.type === "ready") {
        readyRef.current = true;
        const pending = pendingRef.current;
        if (pending) {
          pendingRef.current = null;
          post(pending.runId, pending.code);
        }
        return;
      }
      dispatch({ type: "message", message });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [frame, post]);

  // A frame that never answers (it failed to start, or its worker was lost) does not leave the panel spinning.
  const busy = state.status === "loading" || state.status === "running";
  useEffect(() => {
    if (!busy) return;
    const timer = window.setTimeout(() => {
      dispatch({ type: "stop", outcome: "timeout" });
      pendingRef.current = null;
      newFrame();
    }, FRAME_SILENCE_MS);
    return () => window.clearTimeout(timer);
  }, [busy, newFrame, state.runId]);

  const srcDoc = useMemo(
    () => (frame ? buildCodeRunDocument({ assetOrigin: window.location.origin, token: frame.token, nonce: frame.nonce }) : null),
    [frame]
  );

  const run = () => {
    const code = (preRef.current?.textContent ?? "").replace(/\r?\n$/, "");
    if (!code.trim()) return;
    const runId = randomId();
    if (new TextEncoder().encode(code).byteLength > CODE_RUN_LIMITS.maxCodeBytes) {
      setNotice(t("chat.codeRunCodeTooLarge"));
      return;
    }
    setNotice(null);
    dispatch({ type: "start", runId });
    if (frame && readyRef.current) {
      post(runId, code);
    } else {
      pendingRef.current = { runId, code };
      if (!frame) newFrame();
    }
  };

  const stop = () => {
    // Removing the frame ends its worker, whatever the code is doing.
    pendingRef.current = null;
    dispatch({ type: "stop", outcome: "stopped" });
    newFrame();
  };

  const hide = () => {
    pendingRef.current = null;
    readyRef.current = false;
    setFrame(null);
    dispatch({ type: "reset" });
  };

  const addFiles = async (list: FileList | null) => {
    if (!list) return;
    let refused: string | null = null;
    let next = [...files];
    for (const file of Array.from(list)) {
      const name = sanitizeCodeRunFileName(file.name);
      // The size is known before the file is read, so a refused file is never read.
      const plan = planCodeRunFileAdd(next, { id: "", name, size: file.size, data: new ArrayBuffer(0) });
      if (!plan.ok) {
        refused =
          plan.reason === "count"
            ? t("chat.codeRunFileTooMany").replaceAll("{count}", String(CODE_RUN_LIMITS.maxFiles))
            : plan.reason === "size"
              ? t("chat.codeRunFileTooLarge").replaceAll("{name}", file.name).replaceAll("{size}", megabytes(CODE_RUN_LIMITS.maxFileBytes))
              : t("chat.codeRunFilesTotalTooLarge").replaceAll("{size}", megabytes(CODE_RUN_LIMITS.maxTotalFileBytes));
        continue;
      }
      const data = await file.arrayBuffer();
      next = planCodeRunFileAdd(next, { id: randomId(), name, size: data.byteLength, data }).files;
    }
    setNotice(refused);
    setFiles(next);
  };

  const { fillComposer } = workspace;
  const outputText = codeRunPlainText(state);
  const useResult =
    fillComposer && state.status === "done" && outputText.trim()
      ? () => {
          fillComposer(buildCodeRunComposerText(t("chat.codeRunExplainRequest"), outputText));
        }
      : null;

  if (!workspace.codeRunEnabled || streaming) return null;

  const phaseText =
    state.phase === "packages" ? t("chat.codeRunPhasePackages")
    : state.phase === "running" ? t("chat.codeRunPhaseRunning")
    : t("chat.codeRunPhaseRuntime");

  const outcomeText = (() => {
    if (state.status !== "done") return null;
    const seconds = String(CODE_RUN_LIMITS.runTimeoutMs / 1000);
    switch (state.outcome) {
      case "timeout":
        return state.phase === "running" ? t("chat.codeRunTimedOut").replaceAll("{seconds}", seconds) : t("chat.codeRunLoadTimedOut");
      case "output_limit":
        return t("chat.codeRunOutputLimit");
      case "crashed":
        return t("chat.codeRunCrashed");
      case "stopped":
        return t("chat.codeRunStopped");
      default:
        return t("chat.codeRunFinished").replaceAll("{seconds}", ((state.durationMs ?? 0) / 1000).toFixed(1));
    }
  })();
  const hasAnything = state.segments.length > 0 || state.images.length > 0 || state.value || state.error;
  const label = t("chat.codeRunButtonLabel");

  return (
    <>
      <button
        type="button"
        data-testid="chat-code-run-button"
        onClick={run}
        disabled={busy}
        title={label}
        aria-label={label}
        className="absolute right-11 top-2 inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-semibold text-zinc-400 transition-colors before:absolute before:-inset-y-2 before:content-[''] hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50"
      >
        <Play className="h-3.5 w-3.5" aria-hidden="true" />
        {t("chat.codeRunButton")}
      </button>
      {(frame || notice) && (
        <div
          role="region"
          aria-label={t("chat.codeRunRegion")}
          data-testid="chat-code-run-result"
          className="mt-2 rounded-lg border border-zinc-200 bg-white p-3 text-sm text-zinc-800 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
        >
          {/* The frame: sandbox with scripts and nothing else, no allowed features, no referrer. Never shown. */}
          {frame && srcDoc && (
            <iframe
              key={frame.token}
              ref={iframeRef}
              data-testid="chat-code-run-frame"
              title={t("chat.codeRunRegion")}
              sandbox={CODE_RUN_SANDBOX}
              srcDoc={srcDoc}
              referrerPolicy="no-referrer"
              allow=""
              hidden
            />
          )}
          <div className="flex flex-wrap items-center gap-2">
            <p role="status" aria-live="polite" className="min-w-0 flex-1 text-xs text-zinc-600 dark:text-zinc-300">
              {busy && <Loader2 className="mr-1.5 inline h-3.5 w-3.5 animate-spin align-[-2px] motion-reduce:animate-none" aria-hidden="true" />}
              {busy ? phaseText : outcomeText}
            </p>
            {busy ? (
              <button
                type="button"
                data-testid="chat-code-run-stop"
                onClick={stop}
                className="inline-flex min-h-9 items-center gap-1 rounded-md border border-zinc-300 px-2.5 text-xs font-bold text-zinc-800 hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-zinc-600 dark:text-zinc-100 dark:hover:bg-zinc-800"
              >
                <Square className="h-3 w-3" aria-hidden="true" />
                {t("chat.codeRunStop")}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  data-testid="chat-code-run-again"
                  onClick={run}
                  className="inline-flex min-h-9 items-center gap-1 rounded-md border border-zinc-300 px-2.5 text-xs font-bold text-zinc-800 hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-zinc-600 dark:text-zinc-100 dark:hover:bg-zinc-800"
                >
                  <Play className="h-3 w-3" aria-hidden="true" />
                  {t("chat.codeRunAgain")}
                </button>
                <button
                  type="button"
                  data-testid="chat-code-run-hide"
                  onClick={hide}
                  aria-label={t("chat.codeRunClear")}
                  title={t("chat.codeRunClear")}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-zinc-400 dark:hover:bg-zinc-800"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </>
            )}
          </div>

          {state.segments.length > 0 && (
            <pre data-testid="chat-code-run-output" className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-zinc-100 p-2 font-mono text-xs dark:bg-zinc-950">
              {state.segments.map((segment, index) => (
                <span key={index} className={segment.stream === "stderr" ? "text-red-700 dark:text-red-300" : undefined}>
                  {segment.text}
                </span>
              ))}
            </pre>
          )}
          {state.value && (
            <pre data-testid="chat-code-run-value" className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-zinc-100 p-2 font-mono text-xs dark:bg-zinc-950">
              {state.value}
            </pre>
          )}
          {state.error && (
            <pre data-testid="chat-code-run-error" role="alert" className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-red-50 p-2 font-mono text-xs text-red-800 dark:bg-red-950/40 dark:text-red-200">
              {state.error}
            </pre>
          )}
          {state.images.length > 0 && (
            <div className="mt-2 flex flex-col gap-2">
              {state.images.map((src, index) => (
                // A PNG data URL that passed the frame-message check; an <img> cannot run script.
                // eslint-disable-next-line @next/next/no-img-element
                <img key={index} data-testid="chat-code-run-figure" src={src} alt={t("chat.codeRunFigureAlt").replaceAll("{number}", String(index + 1))} className="h-auto max-w-full rounded-md border border-zinc-200 bg-white dark:border-zinc-700" />
              ))}
            </div>
          )}
          {state.skippedFigures > 0 && (
            <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-300">
              {t("chat.codeRunSkippedFigures").replaceAll("{count}", String(state.skippedFigures))}
            </p>
          )}
          {state.status === "done" && !hasAnything && state.outcome === "ok" && (
            <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-300">{t("chat.codeRunNoOutput")}</p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-zinc-200 pt-2 dark:border-zinc-700">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              accept=".csv,.tsv,.json,.txt,.md,.log,text/csv,text/plain,application/json"
              data-testid="chat-code-run-file-input"
              onChange={(event) => {
                void addFiles(event.target.files);
                event.target.value = "";
              }}
            />
            <button
              type="button"
              data-testid="chat-code-run-add-files"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
              className="inline-flex min-h-9 items-center rounded-md border border-zinc-300 px-2.5 text-xs font-bold text-zinc-800 hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-100 dark:hover:bg-zinc-800"
            >
              {t("chat.codeRunFilesAdd")}
            </button>
            {useResult && (
              <button
                type="button"
                data-testid="chat-code-run-use-result"
                onClick={useResult}
                className="inline-flex min-h-9 items-center rounded-md bg-blue-600 px-2.5 text-xs font-bold text-white hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-zinc-900"
              >
                {t("chat.codeRunUseResult")}
              </button>
            )}
          </div>
          {files.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-1.5" data-testid="chat-code-run-files">
              {files.map((file) => (
                <li key={file.id} className="inline-flex items-center gap-1 rounded-full bg-zinc-100 py-0.5 pl-2.5 pr-1 text-xs dark:bg-zinc-800">
                  <span className="max-w-48 truncate">{file.name}</span>
                  <button
                    type="button"
                    onClick={() => setFiles((current) => current.filter((candidate) => candidate.id !== file.id))}
                    aria-label={t("chat.codeRunFileRemove").replaceAll("{name}", file.name)}
                    className="inline-flex h-5 w-5 items-center justify-center rounded-full hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-zinc-700"
                  >
                    <X className="h-3 w-3" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {notice && <p role="alert" data-testid="chat-code-run-notice" className="mt-1 text-xs font-semibold text-red-700 dark:text-red-300">{notice}</p>}
          <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">{t("chat.codeRunFilesHint")} {t("chat.codeRunPrivacyNote")}</p>
        </div>
      )}
    </>
  );
}
