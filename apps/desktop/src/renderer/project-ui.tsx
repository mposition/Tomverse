import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { ProjectWorkspaceError, type ProjectWorkspaceClient } from "../../../../packages/api-client/src/projectWorkspace";
import { interpolateCopy, projectErrorKey } from "../../../../lib/projectWorkspaceUi";
import type { Language } from "../../../../lib/language";
import { projectWorkspaceCopy } from "../../../../locales/projectWorkspace";
import { de } from "../../../../locales/de";
import { en } from "../../../../locales/en";
import { es } from "../../../../locales/es";
import { fr } from "../../../../locales/fr";
import { ko } from "../../../../locales/ko";
import { pt } from "../../../../locales/pt";
import { zh } from "../../../../locales/zh";
import { zhHant } from "../../../../locales/zhHant";
import type { DesktopApi } from "../contract";
import type { DesktopProjectAction, DesktopProjectInput, DesktopProjectOutcome, DesktopMaterialUploads } from "../project-contract";
import "./project-workspace.css";

const dictionaries = { en, ko, zh, "zh-Hant": zhHant, fr, de, es, pt };

/** Dotted-key lookups into the web's own workspace dictionary, so the wording is the web's wording. */
export function projectCopy(language: Language) {
  const root = { projectWorkspace: projectWorkspaceCopy[language], memoryReview: dictionaries[language].memoryReview } as unknown as Record<string, unknown>;
  const read = (key: string) => key.split(".").reduce<unknown>((value, part) => (value as Record<string, unknown> | undefined)?.[part], root);
  const t = (key: string) => { const value = read(key); return typeof value === "string" ? value : key; };
  const tf = (key: string, values: Record<string, string | number>) => interpolateCopy(t(key), values);
  return { t, tf, language };
}
export type ProjectCopy = ReturnType<typeof projectCopy>;
export const useProjectCopy = (language: Language) => useMemo(() => projectCopy(language), [language]);

export const formatProjectDate = (value: string | null | undefined, language: Language) => {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(language);
};

type Call = <Action extends DesktopProjectAction>(input: Extract<DesktopProjectInput, { action: Action }>) => Promise<DesktopProjectOutcome<Action>>;

/**
 * The renderer's view of the workspace API: the same method names and shapes as the shared client,
 * with every call carried over the typed `desktop.projects` bridge. A refusal is rethrown as the
 * shared ProjectWorkspaceError so the web's own helpers (error wording, delete confirmation, settings
 * save) work on it unchanged.
 */
export function createDesktopProjectClient(call: Call = (input) => (window.desktop as DesktopApi).projects(input)) {
  async function run<Action extends DesktopProjectAction>(input: Extract<DesktopProjectInput, { action: Action }>) {
    const outcome = await call<Action>(input);
    if (!outcome.ok) throw new ProjectWorkspaceError(outcome.status, outcome.code, outcome.details);
    return outcome.value;
  }
  const unavailable = () => Promise.reject(new ProjectWorkspaceError(501, "UPLOAD_UNAVAILABLE"));
  const client = {
    list: () => run<"list">({ action: "list" }),
    detail: (projectId: string) => run<"detail">({ action: "detail", projectId }),
    create: (input: { name: string; description?: string; instructions?: string; contextEnabled: boolean; memoryScope?: "project_only" | "project_and_personal"; autoMemoryEnabled?: boolean }) =>
      run<"create">({ action: "create", ...input }),
    update: (projectId: string, expectedRevision: number, patch: Extract<DesktopProjectInput, { action: "update" }>["patch"]) =>
      run<"update">({ action: "update", projectId, expectedRevision, patch }),
    rename: (projectId: string, name: string) => run<"rename">({ action: "rename", projectId, name }),
    deletionSummary: (projectId: string) => run<"deletionSummary">({ action: "deletionSummary", projectId }),
    remove: (projectId: string, confirmation?: { revision: number; materials: number; memories: number }) =>
      run<"remove">({ action: "remove", projectId, ...(confirmation ? { confirmation } : {}) }),
    conversations: (projectId: string) => run<"conversations">({ action: "conversations", projectId }),
    materials: (projectId: string) => run<"materials">({ action: "materials", projectId }),
    uploadMaterials: (projectId: string): Promise<DesktopMaterialUploads> => run<"uploadMaterials">({ action: "uploadMaterials", projectId }),
    downloadMaterial: (projectId: string, fileId: string) => run<"downloadMaterial">({ action: "downloadMaterial", projectId, fileId }),
    // The workspace never hands file bytes or signed links to the renderer.
    uploadMaterial: unavailable,
    materialLink: unavailable,
    addNote: (projectId: string, title: string, text: string, clientRequestId: string) => run<"addNote">({ action: "addNote", projectId, title, text, clientRequestId }),
    saveSource: (projectId: string, source: Extract<DesktopProjectInput, { action: "saveSource" }>["source"], clientRequestId: string) =>
      run<"saveSource">({ action: "saveSource", projectId, source, clientRequestId }),
    retryMaterial: (projectId: string, fileId: string) => run<"retryMaterial">({ action: "retryMaterial", projectId, fileId }),
    deleteMaterial: (projectId: string, fileId: string) => run<"deleteMaterial">({ action: "deleteMaterial", projectId, fileId }),
    memories: (projectId: string) => run<"memories">({ action: "memories", projectId }),
    personalMemories: (projectId: string) => run<"personalMemories">({ action: "personalMemories", projectId }),
    createMemory: (projectId: string, input: Extract<DesktopProjectInput, { action: "createMemory" }>["input"]) => run<"createMemory">({ action: "createMemory", projectId, input }),
    editMemory: (projectId: string, memoryId: string, statement: string) => run<"editMemory">({ action: "editMemory", projectId, memoryId, statement }),
    pinMemory: (projectId: string, memoryId: string, pinned: boolean) => run<"pinMemory">({ action: "pinMemory", projectId, memoryId, pinned }),
    deleteMemory: (projectId: string, memoryId: string) => run<"deleteMemory">({ action: "deleteMemory", projectId, memoryId }),
    moveMemory: (memoryId: string, expectedRevision: number, targetProjectId: string | null) => run<"moveMemory">({ action: "moveMemory", memoryId, expectedRevision, targetProjectId }),
    search: (projectId: string, query: string) => run<"search">({ action: "search", projectId, query }),
    readSource: (projectId: string, ref: string) => run<"readSource">({ action: "readSource", projectId, ref }),
    receipt: (messageId: string) => run<"receipt">({ action: "receipt", messageId }),
    moveConversation: (conversationId: string, projectId: string | null) => run<"moveConversation">({ action: "moveConversation", conversationId, projectId }),
  };
  return client;
}
export type DesktopProjectClient = ReturnType<typeof createDesktopProjectClient>;
/** The shared helpers (settings save, delete plan) only touch methods this client implements. */
export const asSharedClient = (client: DesktopProjectClient) => client as unknown as ProjectWorkspaceClient;

let shared: DesktopProjectClient | undefined;
export const desktopProjectClient = () => (shared ??= createDesktopProjectClient());

type ResourceState<T> = { key: string; status: "loading" | "ready" | "error"; data?: T; error?: unknown };

/** Loads one thing for a pane; a new key starts clean and a late answer for an old key is dropped. */
export function useProjectResource<T>(load: () => Promise<T>, key: string) {
  const [state, setState] = useState<ResourceState<T>>({ key, status: "loading" });
  const loadRef = useRef(load);
  const generation = useRef(0);
  useLayoutEffect(() => { loadRef.current = load; });
  const run = useCallback(async (options?: { quiet?: boolean }) => {
    const ticket = ++generation.current;
    if (!options?.quiet) setState((current) => current.key === key && current.status === "ready" ? current : { key, status: "loading" });
    try {
      const data = await loadRef.current();
      if (ticket === generation.current) setState({ key, status: "ready", data });
    } catch (error) {
      if (ticket === generation.current) {
        setState((current) => options?.quiet && current.key === key && current.status === "ready" ? current : { key, status: "error", error });
      }
    }
  }, [key]);
  useEffect(() => {
    queueMicrotask(() => void run());
    // A reload still in flight when the pane goes away must not publish: the ticket counter is the live value on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { generation.current++; };
  }, [run]);
  const current = state.key === key ? state : { key, status: "loading" as const };
  return { status: current.status, data: current.data, error: current.error, reload: run };
}

export function Spinner({ label }: { label: string }) {
  return <p className="pw-muted" role="status"><Loader2 size={14} className="pw-spin" aria-hidden="true" /> {label}</p>;
}

export function ErrorLine({ error, copy, onRetry, testId }: { error: unknown; copy: ProjectCopy; onRetry?: () => void; testId?: string }) {
  return <p role="alert" className="pw-error" data-testid={testId}>
    {copy.t(projectErrorKey(error))}
    {onRetry && <> <button type="button" className="soft" onClick={onRetry}>{copy.t("projectWorkspace.retry")}</button></>}
  </p>;
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return <div className="pw-card pw-empty"><strong>{title}</strong><p className="pw-muted">{body}</p>{action}</div>;
}

export function ConfirmDialog({ open, title, confirmLabel, cancelLabel, busy, error, destructive, onCancel, onConfirm, children, copy, testId }: {
  open: boolean; title: string; confirmLabel: string; cancelLabel: string; busy: boolean; error: unknown; destructive?: boolean;
  onCancel: () => void; onConfirm: () => void; children: ReactNode; copy: ProjectCopy; testId?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const panel = dialog.current;
    if (!panel) return;
    if (open && !panel.open) panel.showModal();
    if (!open && panel.open) panel.close();
  }, [open]);
  return <dialog ref={dialog} className="task-github-dialog pw-dialog" data-testid={testId} aria-label={title}
    onCancel={(event) => { event.preventDefault(); if (!busy) onCancel(); }}>
    {open && <div>
      <header><h2>{title}</h2></header>
      <div className="pw-dialog-body">{children}</div>
      {error ? <ErrorLine error={error} copy={copy} /> : null}
      <footer className="pw-actions">
        <button type="button" className="soft" disabled={busy} onClick={onCancel}>{cancelLabel}</button>
        <button type="button" className={destructive ? "pw-danger" : "primary"} disabled={busy} onClick={onConfirm}>{confirmLabel}</button>
      </footer>
    </div>}
  </dialog>;
}
