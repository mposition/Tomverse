"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { ChevronLeft, Monitor } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import type { Language } from "@/lib/language";
import {
  DESKTOP_REMOTE_LIMITS,
  type DesktopRemoteCommandRequest,
  type DesktopRemoteDecision,
  type DesktopRemoteDeviceView,
  type DesktopRemoteDevicesResponse,
  type DesktopRemoteTask,
} from "@/lib/desktopRemoteControlContract";
import { desktopRemoteCopy, type DesktopRemoteCopy } from "@/locales/desktopRemote";

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
};

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

function TaskScreen(props: RemoteViewProps & { device: DesktopRemoteDeviceView; task: DesktopRemoteTask; canAct: boolean; copy: DesktopRemoteCopy }) {
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
          {approval.files.map((file) => <li key={file.path} className="break-all">{file.action} {file.path}</li>)}
          {approval.moreFiles > 0 && <li>{fill(copy.moreFiles, { count: approval.moreFiles })}</li>}
        </ul>}
        {!approval.remote && <p className="mt-3 text-sm font-medium" data-testid="remote-pc-only">{copy.pcOnly}. {copy.pcOnlyDetail}</p>}
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
          className={`${button} mt-2 w-full border border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-900`}>{copy.send}</button>
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
    <TaskScreen {...props} device={device} task={task} canAct={canAct} copy={copy} />
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
  const stopTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

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
  useEffect(() => () => clearTimeout(stopTimer.current), []);

  const data = state.kind === "ready" || state.kind === "failed" ? state.data : undefined;
  const device = data?.devices.find((entry) => entry.deviceId === deviceId);
  const task = device?.snapshot.tasks.find((entry) => entry.key === taskKey);

  async function send(command: DesktopRemoteCommandRequest) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/desktop/remote/commands", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command),
      });
      const body = await response.json().catch(() => null) as { code?: keyof DesktopRemoteCopy["error"] } | null;
      if (response.ok) { setMessage(copy.state.waiting); return true; }
      setMessage((body?.code && copy.error[body.code]) || copy.error.generic);
      return false;
    } catch {
      setMessage(copy.error.generic);
      return false;
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
  />;
}
