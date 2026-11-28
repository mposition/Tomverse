"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { ChevronLeft, Monitor } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import type { Language } from "@/lib/language";
import {
  DESKTOP_REMOTE_LIMITS,
  DESKTOP_REMOTE_PASSKEY_LIMITS,
  desktopRemoteNeedsPasskey,
  type DesktopRemoteCommandRequest,
  type DesktopRemoteDecision,
  type DesktopRemoteDeviceView,
  type DesktopRemoteDevicesResponse,
  type DesktopRemotePasskeyAssertion,
  type DesktopRemotePasskeyState,
  type DesktopRemoteTask,
} from "@/lib/desktopRemoteControlContract";
import { desktopRemoteCopy, type DesktopRemoteCopy } from "@/locales/desktopRemote";
import {
  createPasskey, getPasskeyAssertion, passkeysSupported, type PasskeyCreationOptions, type PasskeyRequestOptions,
} from "./passkeyClient";

/**
 * /remote: the account's PCs that run Code tasks in Tomverse Desktop, their tasks, and the approval request on each
 * PC's screen (docs/ops/desktop-remote-control.md). Made for one hand on a phone: one column, the actions in a bar at
 * the bottom of the screen. Every answer goes to the PC, which decides whether it still applies.
 */

export type RemoteScreenState =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "failed"; data?: DesktopRemoteDevicesResponse }
  | { kind: "ready"; data: DesktopRemoteDevicesResponse };

export type RemoteViewProps = {
  language: Language;
  state: RemoteScreenState;
  deviceId: string | null;
  taskKey: string | null;
  busy: boolean;
  message: string | null;
  stopArmed: boolean;
  draft: string;
  onSelectDevice(deviceId: string | null): void;
  onSelectTask(taskKey: string | null): void;
  onAnswer(decision: DesktopRemoteDecision): void;
  onStop(): void;
  onDraft(text: string): void;
  onSendFollowUp(): void;
  onSignInAgain(): void;
  /** Passkeys: the name being typed, the one armed for removal, and what the buttons do. Absent in a view that offers none. */
  passkeyName?: string;
  removeArmed?: string | null;
  onPasskeyName?(text: string): void;
  onAddPasskey?(): void;
  onRemovePasskey?(id: string): void;
};

/** An account that registered a passkey confirms "allow once" and follow-ups with it, where the server offers them. */
const passkeyIsActive = (passkey: DesktopRemotePasskeyState | undefined) => passkey?.enabled === true && passkey.passkeys.length > 0;

const fill = (template: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), template);

const time = (iso: string, language: Language) => {
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
};

const button = "min-h-12 rounded-xl px-4 text-base font-semibold disabled:opacity-50";

function Header({ title, back, onBack }: { title: string; back?: string; onBack?: () => void }) {
  return <header className="sticky top-0 z-10 flex min-h-14 items-center gap-2 border-b border-zinc-200 bg-zinc-50/95 px-3 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/95">
    {back && onBack && <button type="button" onClick={onBack} className="flex min-h-11 items-center gap-1 rounded-lg px-2 text-sm text-zinc-600 dark:text-zinc-300"
      data-testid="remote-back"><ChevronLeft aria-hidden className="size-5" />{back}</button>}
    <h1 className="truncate text-lg font-semibold">{title}</h1>
  </header>;
}

function TaskRow({ task, copy, waiting, onOpen }: { task: DesktopRemoteTask; copy: DesktopRemoteCopy; waiting: boolean; onOpen: () => void }) {
  return <li>
    <button type="button" onClick={onOpen} data-testid="remote-task" className="flex w-full flex-col items-start gap-1 rounded-xl border border-zinc-200 bg-white p-4 text-left dark:border-zinc-800 dark:bg-zinc-900">
      <span className="text-base font-medium">{task.title}</span>
      <span className="text-sm text-zinc-500 dark:text-zinc-400">{copy.kind[task.kind]} · {copy.status[task.status]}</span>
      {waiting && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-200">{copy.waitingApproval}</span>}
    </button>
  </li>;
}

function PasskeyPanel(props: RemoteViewProps & { copy: DesktopRemoteCopy; passkey: DesktopRemotePasskeyState; canAct: boolean }) {
  const { copy, passkey, canAct, busy } = props;
  const full = passkey.passkeys.length >= DESKTOP_REMOTE_PASSKEY_LIMITS.perAccount;
  return <section aria-labelledby="remote-passkeys" className="flex flex-col gap-2 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900" data-testid="remote-passkeys">
    <h2 id="remote-passkeys" className="text-sm font-semibold">{copy.passkeyTitle}</h2>
    <p className="text-sm text-zinc-600 dark:text-zinc-300">{copy.passkeyIntro}</p>
    {passkey.passkeys.length === 0 ? <p className="text-sm" data-testid="remote-passkey-none">{copy.passkeyNone}</p>
      : <ul className="flex flex-col gap-2 text-sm" data-testid="remote-passkey-list">{passkey.passkeys.map((entry) => <li key={entry.id} className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{entry.label}</span>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">{fill(copy.passkeyAdded, { date: new Date(entry.createdAt).toLocaleDateString(props.language) })} · {entry.lastUsedAt ? fill(copy.passkeyUsed, { date: new Date(entry.lastUsedAt).toLocaleDateString(props.language) }) : copy.passkeyNever}</span>
        </span>
        <button type="button" onClick={() => props.onRemovePasskey?.(entry.id)} disabled={!canAct || busy} data-testid="remote-passkey-remove"
          className="min-h-11 shrink-0 rounded-lg border border-red-300 px-3 text-red-700 disabled:opacity-50 dark:border-red-800 dark:text-red-300">
          {props.removeArmed === entry.id ? copy.passkeyRemoveConfirm : copy.passkeyRemove}</button>
      </li>)}</ul>}
    {!full && <div className="flex flex-col gap-2">
      <label htmlFor="remote-passkey-name" className="text-sm font-medium">{copy.passkeyName}</label>
      <input id="remote-passkey-name" data-testid="remote-passkey-name" value={props.passkeyName ?? ""} maxLength={DESKTOP_REMOTE_PASSKEY_LIMITS.label}
        placeholder={copy.passkeyNamePlaceholder} disabled={!canAct || busy} onChange={(event) => props.onPasskeyName?.(event.currentTarget.value)}
        className="min-h-11 rounded-xl border border-zinc-300 bg-white px-3 text-base dark:border-zinc-700 dark:bg-zinc-900" />
      <button type="button" onClick={props.onAddPasskey} disabled={!canAct || busy || !(props.passkeyName ?? "").trim()} data-testid="remote-passkey-add"
        className={`${button} border border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-900`}>{copy.passkeyAdd}</button>
    </div>}
  </section>;
}

function TaskScreen(props: RemoteViewProps & { device: DesktopRemoteDeviceView; task: DesktopRemoteTask; canAct: boolean; copy: DesktopRemoteCopy; passkeyActive: boolean }) {
  const { device, task, canAct, copy, busy } = props;
  const approval = device.snapshot.approval?.taskKey === task.key ? device.snapshot.approval : null;
  const answered = approval ? device.commands.find((command) => command.kind === "approval" && command.approvalId === approval.id) : undefined;
  const sent = device.commands.filter((command) => command.taskKey === task.key).slice(0, 5);
  return <>
    <Header title={task.title} back={copy.allTasks} onBack={() => props.onSelectTask(null)} />
    <div className="flex flex-1 flex-col gap-4 p-4 pb-40">
      <p className="text-sm text-zinc-600 dark:text-zinc-300" data-testid="remote-task-status">
        {copy.kind[task.kind]} · {copy.status[task.status]}{task.changes ? ` · ${fill(copy.changes, { count: task.changes })}` : ""}
      </p>
      {task.progress.length > 0 && <section aria-labelledby="remote-progress">
        <h2 id="remote-progress" className="mb-2 text-sm font-semibold text-zinc-500 dark:text-zinc-400">{copy.progressTitle}</h2>
        <ul className="flex flex-col gap-1 text-sm" data-testid="remote-progress">{task.progress.map((line, index) => <li key={index}>{line}</li>)}</ul>
      </section>}
      {approval && <section aria-labelledby="remote-approval" data-testid="remote-approval" data-remote={approval.remote}
        className="rounded-xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/40">
        <h2 id="remote-approval" className="text-sm font-semibold">{copy.approvalTitle} · {copy.approvalKind[approval.kind]}</h2>
        {approval.target && <pre className="mt-2 whitespace-pre-wrap break-all rounded-lg bg-white p-3 font-mono text-sm dark:bg-zinc-900" data-testid="remote-approval-target">{approval.target}</pre>}
        {approval.files.length > 0 && <ul className="mt-2 flex flex-col gap-1 font-mono text-sm" data-testid="remote-approval-files">
          {approval.files.map((file) => <li key={file.path} className="break-all">
            {file.action} {file.path}
            {(file.added !== undefined || file.removed !== undefined) && <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400" data-testid="remote-approval-counts">
              {fill(copy.lineCounts, { added: file.added ?? 0, removed: file.removed ?? 0 })}</span>}
            {file.omitted && <span className="block text-xs text-zinc-500 dark:text-zinc-400" data-testid="remote-approval-omitted">{copy.previewOmitted[file.omitted]}</span>}
            {file.preview && file.preview.length > 0 && <>
              <span className="mt-1 block text-xs text-zinc-500 dark:text-zinc-400">{copy.previewTitle}</span>
              <pre className="whitespace-pre-wrap break-all rounded-lg bg-white p-2 text-xs dark:bg-zinc-900" data-testid="remote-approval-preview">{file.preview.join("\n")}</pre>
            </>}
          </li>)}
          {approval.moreFiles > 0 && <li>{fill(copy.moreFiles, { count: approval.moreFiles })}</li>}
        </ul>}
        {!approval.remote && <p className="mt-3 text-sm font-medium" data-testid="remote-pc-only">{copy.pcOnly}. {copy.pcOnlyDetail}</p>}
        {approval.remote && !answered && props.passkeyActive && <p className="mt-3 text-sm font-medium" data-testid="remote-passkey-needed">{copy.confirmWithPasskey}</p>}
        {answered && <p className="mt-3 text-sm" data-testid="remote-answered">{copy.action[answered.decision ?? "once"]} · {copy.state[answered.state]}</p>}
      </section>}
      {sent.length > 0 && <section aria-labelledby="remote-sent">
        <h2 id="remote-sent" className="mb-2 text-sm font-semibold text-zinc-500 dark:text-zinc-400">{copy.lastActions}</h2>
        <ul className="flex flex-col gap-1 text-sm" data-testid="remote-sent">{sent.map((command) => <li key={command.id}>
          {copy.action[command.kind === "approval" ? command.decision ?? "once" : command.kind]} · {copy.state[command.state]} · {time(command.createdAt, props.language)}
        </li>)}</ul>
      </section>}
      {task.canFollowUp && <section aria-labelledby="remote-follow-up">
        <label id="remote-follow-up" htmlFor="remote-follow-up-text" className="mb-2 block text-sm font-semibold">{copy.followUpLabel}</label>
        <textarea id="remote-follow-up-text" data-testid="remote-follow-up" value={props.draft} maxLength={DESKTOP_REMOTE_LIMITS.followUp} rows={3}
          disabled={!canAct || busy} placeholder={copy.followUpPlaceholder} onChange={(event) => props.onDraft(event.currentTarget.value)}
          className="w-full rounded-xl border border-zinc-300 bg-white p-3 text-base dark:border-zinc-700 dark:bg-zinc-900" />
        <button type="button" onClick={props.onSendFollowUp} disabled={!canAct || busy || !props.draft.trim()} data-testid="remote-follow-up-send"
          className={`${button} mt-2 w-full border border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-900`}>{props.passkeyActive ? `${copy.send} · ${copy.confirmWithPasskey}` : copy.send}</button>
      </section>}
    </div>
    <div className="fixed inset-x-0 bottom-0 z-10 mx-auto flex max-w-xl flex-col gap-2 border-t border-zinc-200 bg-zinc-50/95 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/95">
      {approval?.remote && !answered && <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={() => props.onAnswer("deny")} disabled={!canAct || busy} data-testid="remote-deny"
          className={`${button} border border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-900`}>{copy.deny}</button>
        <button type="button" onClick={() => props.onAnswer("once")} disabled={!canAct || busy} data-testid="remote-allow-once"
          className={`${button} bg-zinc-900 text-white dark:bg-white dark:text-zinc-900`}>{copy.allowOnce}</button>
      </div>}
      {task.canStop && <button type="button" onClick={props.onStop} disabled={!canAct || busy} data-testid="remote-stop"
        className={`${button} border border-red-300 text-red-700 dark:border-red-800 dark:text-red-300`}>{props.stopArmed ? copy.stopConfirm : copy.stop}</button>}
    </div>
  </>;
}

/** The screen itself, with no fetching: what the tests render. */
export function DesktopRemoteView(props: RemoteViewProps) {
  const copy = desktopRemoteCopy[props.language];
  const { state } = props;
  const data = state.kind === "ready" || state.kind === "failed" ? state.data : undefined;
  const device = data?.devices.find((entry) => entry.deviceId === props.deviceId) ?? null;
  const task = device?.snapshot.tasks.find((entry) => entry.key === props.taskKey) ?? null;
  const canAct = data?.canAct === true;

  let body: ReactNode;
  if (state.kind === "unavailable") body = <p className="p-4" data-testid="remote-unavailable">{copy.notAvailable}</p>;
  else if (!data) body = state.kind === "failed" ? <p className="p-4" role="alert">{copy.loadFailed}</p> : null;
  else if (device && task) return <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100" data-testid="remote-screen">
    {!canAct && <ViewOnly copy={copy} onSignInAgain={props.onSignInAgain} />}
    <TaskScreen {...props} device={device} task={task} canAct={canAct} copy={copy} passkeyActive={passkeyIsActive(data?.passkey)} />
    {props.message && <p role="status" className="fixed inset-x-0 bottom-36 mx-auto w-fit rounded-full bg-zinc-900 px-4 py-2 text-sm text-white dark:bg-white dark:text-zinc-900" data-testid="remote-message">{props.message}</p>}
  </main>;
  else if (device) body = <>
    <Header title={device.label} back={copy.allPcs} onBack={() => props.onSelectDevice(null)} />
    <div className="flex flex-col gap-3 p-4">
      <p className="text-sm text-zinc-500 dark:text-zinc-400">{fill(copy.updated, { time: time(device.updatedAt, props.language) })}</p>
      {device.snapshot.tasks.length ? <ul className="flex flex-col gap-2">{device.snapshot.tasks.map((entry) => <TaskRow key={entry.key} task={entry} copy={copy}
        waiting={device.snapshot.approval?.taskKey === entry.key} onOpen={() => props.onSelectTask(entry.key)} />)}</ul>
        : <p data-testid="remote-no-tasks">{copy.noTasks}</p>}
    </div>
  </>;
  else body = <>
    <Header title={copy.pageTitle} />
    <div className="flex flex-col gap-3 p-4">
      <p className="text-sm text-zinc-500 dark:text-zinc-400">{copy.intro}</p>
      {data.devices.length ? <ul className="flex flex-col gap-2">{data.devices.map((entry) => <li key={entry.deviceId}>
        <button type="button" onClick={() => props.onSelectDevice(entry.deviceId)} data-testid="remote-device"
          className="flex w-full items-center gap-3 rounded-xl border border-zinc-200 bg-white p-4 text-left dark:border-zinc-800 dark:bg-zinc-900">
          <Monitor aria-hidden className="size-6 shrink-0 text-zinc-500" />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-base font-medium">{entry.label}</span>
            <span className="text-sm text-zinc-500 dark:text-zinc-400">{fill(copy.taskCount, { count: entry.snapshot.tasks.length })}</span>
            {entry.snapshot.approval && <span className="text-sm font-medium text-amber-700 dark:text-amber-300">{copy.waitingApproval}</span>}
          </span>
        </button>
      </li>)}</ul> : <p data-testid="remote-empty">{copy.empty}</p>}
      {data.passkey?.enabled && <PasskeyPanel {...props} copy={copy} passkey={data.passkey} canAct={canAct} />}
    </div>
  </>;
  return <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100" data-testid="remote-screen">
    {data && !canAct && <ViewOnly copy={copy} onSignInAgain={props.onSignInAgain} />}
    {body}
    {props.message && <p role="status" className="mx-4 rounded-xl bg-zinc-900 px-4 py-2 text-sm text-white dark:bg-white dark:text-zinc-900" data-testid="remote-message">{props.message}</p>}
  </main>;
}

function ViewOnly({ copy, onSignInAgain }: { copy: DesktopRemoteCopy; onSignInAgain: () => void }) {
  return <div className="flex flex-col gap-2 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/50 dark:text-amber-100" data-testid="remote-view-only">
    <p>{copy.viewOnly}</p>
    <button type="button" onClick={onSignInAgain} className="min-h-11 self-start rounded-lg border border-amber-400 px-3 font-medium">{copy.signInAgain}</button>
  </div>;
}

const POLL_MS = 3_000;
const PASSKEY_URL = "/api/desktop/remote/passkey";
const SIGN_IN = `/auth/signin?${new URLSearchParams({ callbackUrl: "/remote" })}`;

type Loaded = { kind: "ready"; data: DesktopRemoteDevicesResponse } | { kind: "unavailable" } | { kind: "signed_out" } | { kind: "failed" };

async function readDevices(): Promise<Loaded> {
  try {
    const response = await fetch("/api/desktop/remote/devices", { cache: "no-store" });
    const body = await response.json().catch(() => null) as (DesktopRemoteDevicesResponse & { code?: string }) | null;
    if (response.status === 503 && body?.code === "NOT_AVAILABLE") return { kind: "unavailable" };
    if (response.status === 401) return { kind: "signed_out" };
    return response.ok && body?.ok ? { kind: "ready", data: body } : { kind: "failed" };
  } catch {
    return { kind: "failed" };
  }
}

export function DesktopRemoteWorkspace() {
  const { lang } = useLanguage();
  const router = useRouter();
  const copy = desktopRemoteCopy[lang];
  const [state, setState] = useState<RemoteScreenState>({ kind: "loading" });
  const [reload, setReload] = useState(0);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [taskKey, setTaskKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [stopArmed, setStopArmed] = useState(false);
  const [draft, setDraft] = useState("");
  const [passkeyName, setPasskeyName] = useState("");
  const [removeArmed, setRemoveArmed] = useState<string | null>(null);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const removeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Refreshes while the page is visible; `reload` reads again at once after an action.
  useEffect(() => {
    let current = true;
    const read = () => readDevices().then((loaded) => {
      if (!current) return;
      if (loaded.kind === "signed_out") { router.replace(SIGN_IN); return; }
      setState((previous) => loaded.kind !== "failed" ? loaded
        : { kind: "failed", data: previous.kind === "ready" || previous.kind === "failed" ? previous.data : undefined });
    });
    void read();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void read(); }, POLL_MS);
    return () => { current = false; clearInterval(timer); };
  }, [reload, router]);
  useEffect(() => () => { clearTimeout(stopTimer.current); clearTimeout(removeTimer.current); }, []);

  const data = state.kind === "ready" || state.kind === "failed" ? state.data : undefined;
  const device = data?.devices.find((entry) => entry.deviceId === deviceId);
  const task = device?.snapshot.tasks.find((entry) => entry.key === taskKey);

  const passkeyActive = passkeyIsActive(data?.passkey);

  async function postJson(url: string, body: unknown) {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await response.json().catch(() => null) as Record<string, unknown> | null;
    return { ok: response.ok && json?.ok === true, json };
  }
  const refusalText = (json: Record<string, unknown> | null) => {
    const code = typeof json?.code === "string" ? json.code : "";
    return (copy.error as Record<string, string>)[code] || copy.error.generic;
  };

  /** One assertion with a passkey of this account over what the server bound the challenge to; or the words to show. */
  async function assertion(options: object): Promise<DesktopRemotePasskeyAssertion | string> {
    if (!passkeysSupported()) return copy.passkeyUnsupported;
    const asked = await postJson(PASSKEY_URL, options);
    if (!asked.ok || !asked.json) return refusalText(asked.json);
    try {
      return { challengeId: String(asked.json.challengeId), ...await getPasskeyAssertion(asked.json.publicKey as PasskeyRequestOptions) };
    } catch {
      return copy.passkeyCancelled;
    }
  }

  async function send(command: DesktopRemoteCommandRequest) {
    setBusy(true);
    setMessage(null);
    try {
      let body: object = command;
      if (passkeyActive && desktopRemoteNeedsPasskey(command)) {
        setMessage(copy.confirmWithPasskey);
        const proof = await assertion({ action: "options-command", command });
        if (typeof proof === "string") { setMessage(proof); return false; }
        body = { ...command, passkey: proof };
      }
      const response = await fetch("/api/desktop/remote/commands", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (response.ok) { setMessage(copy.state.waiting); return true; }
      setMessage(refusalText(result));
      return false;
    } catch {
      setMessage(copy.error.generic);
      return false;
    } finally {
      setBusy(false);
      setReload((value) => value + 1);
    }
  }

  async function addPasskey() {
    const label = passkeyName.trim();
    if (!label || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      if (!passkeysSupported()) { setMessage(copy.passkeyUnsupported); return; }
      const asked = await postJson(PASSKEY_URL, { action: "options-register" });
      if (!asked.ok || !asked.json) { setMessage(refusalText(asked.json)); return; }
      // An account that has a passkey adds the next one only with it.
      let confirmation: DesktopRemotePasskeyAssertion | undefined;
      const confirm = asked.json.confirm as { challengeId: string; publicKey: PasskeyRequestOptions } | undefined;
      if (confirm) {
        try { confirmation = { challengeId: confirm.challengeId, ...await getPasskeyAssertion(confirm.publicKey) }; }
        catch { setMessage(copy.passkeyCancelled); return; }
      }
      let made;
      try { made = await createPasskey(asked.json.publicKey as PasskeyCreationOptions); }
      catch { setMessage(copy.passkeyCancelled); return; }
      const saved = await postJson(PASSKEY_URL, {
        action: "register", challengeId: asked.json.challengeId, label, ...made, ...(confirmation ? { passkey: confirmation } : {}),
      });
      if (!saved.ok) { setMessage(refusalText(saved.json)); return; }
      setPasskeyName("");
      setMessage(copy.passkeyDone);
    } catch {
      setMessage(copy.error.generic);
    } finally {
      setBusy(false);
      setReload((value) => value + 1);
    }
  }

  async function removePasskey(id: string) {
    if (busy) return;
    // Two taps: a passkey removed by a stray touch has to be made again.
    if (removeArmed !== id) {
      setRemoveArmed(id);
      clearTimeout(removeTimer.current);
      removeTimer.current = setTimeout(() => setRemoveArmed(null), 4_000);
      return;
    }
    setRemoveArmed(null);
    setBusy(true);
    setMessage(null);
    try {
      const proof = await assertion({ action: "options-remove", passkeyId: id });
      if (typeof proof === "string") { setMessage(proof); return; }
      const removed = await postJson(PASSKEY_URL, { action: "remove", passkeyId: id, passkey: proof });
      setMessage(removed.ok ? copy.passkeyRemoved : refusalText(removed.json));
    } catch {
      setMessage(copy.error.generic);
    } finally {
      setBusy(false);
      setReload((value) => value + 1);
    }
  }

  return <DesktopRemoteView
    language={lang} state={state} deviceId={deviceId} taskKey={taskKey} busy={busy} message={message} stopArmed={stopArmed} draft={draft}
    onSelectDevice={(id) => { setDeviceId(id); setTaskKey(null); setMessage(null); }}
    onSelectTask={(key) => { setTaskKey(key); setMessage(null); setStopArmed(false); setDraft(""); }}
    onAnswer={(decision) => {
      const approval = device?.snapshot.approval;
      if (!device || !task || !approval || approval.taskKey !== task.key) return;
      void send({ kind: "approval", deviceId: device.deviceId, taskKey: task.key, approvalId: approval.id, digest: approval.digest, decision });
    }}
    onStop={() => {
      if (!device || !task) return;
      // Two taps: a task stopped by a stray touch cannot be started again from here.
      if (!stopArmed) {
        setStopArmed(true);
        clearTimeout(stopTimer.current);
        stopTimer.current = setTimeout(() => setStopArmed(false), 4_000);
        return;
      }
      setStopArmed(false);
      void send({ kind: "stop", deviceId: device.deviceId, taskKey: task.key });
    }}
    onDraft={setDraft}
    onSendFollowUp={() => {
      const text = draft.trim();
      if (!device || !task || !text) return;
      void send({ kind: "follow_up", deviceId: device.deviceId, taskKey: task.key, text }).then((sent) => { if (sent) setDraft(""); });
    }}
    onSignInAgain={() => { void signOut({ callbackUrl: SIGN_IN }); }}
    passkeyName={passkeyName} removeArmed={removeArmed} onPasskeyName={setPasskeyName}
    onAddPasskey={() => { void addPasskey(); }} onRemovePasskey={(id) => { void removePasskey(id); }}
  />;
}
