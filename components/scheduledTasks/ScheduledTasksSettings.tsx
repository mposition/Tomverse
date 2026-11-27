"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { useLanguage } from "@/components/LanguageProvider";
import { useModelCatalog } from "@/components/ModelCatalogProvider";
import { SettingsDetailNav } from "@/components/settings/SettingsDetailNav";
import { conversationHandoffHref } from "@/lib/continuationRoutes";
import { DEFAULT_MODEL_ID } from "@/lib/models";
import {
  SCHEDULED_TASK_FREQUENCIES,
  SCHEDULED_TASK_LIMITS,
  type ScheduledTaskFrequency,
} from "@/lib/scheduledTaskCore";
import { formatScheduledTasksCopy, scheduledTasksCopy } from "@/locales/scheduledTasks";

/**
 * /settings/scheduled-tasks.
 *
 * Saving is two steps on purpose. The first request asks the server for the
 * per-run credit quote and saves nothing; the person sees "one run uses up to
 * N credits" and confirms that exact figure. The server refuses any save whose
 * confirmed figure is not its own current quote, and the runner refuses any
 * run that would reserve more -- so the number on this screen is the ceiling.
 */

type Task = {
  id: string;
  title: string;
  prompt: string;
  modelId: string;
  webSearch: boolean;
  frequency: ScheduledTaskFrequency;
  timeOfDay: string;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  runOnDate: string | null;
  timeZone: string;
  status: "active" | "paused" | "completed";
  pauseReason: string | null;
  creditsPerRun: number;
  nextRunAt: string | null;
  conversationId: string | null;
  revision: number;
  lastRun: {
    status: string;
    outcome: string | null;
    scheduledFor: string;
    finishedAt: string | null;
    chargedCredits: number | null;
    conversationId: string | null;
  } | null;
};

type Listing = {
  enabled: boolean;
  planAllowed: boolean;
  limits: { maxActiveTasks: number; maxTasks: number; titleCharacters: number; promptCharacters: number };
  tasks: Task[];
};

type Form = {
  title: string;
  prompt: string;
  modelId: string;
  webSearch: boolean;
  frequency: ScheduledTaskFrequency;
  timeOfDay: string;
  dayOfWeek: number;
  dayOfMonth: number;
  runOnDate: string;
};

type Confirmation = { credits: number; kind: "save" } | { credits: number; kind: "resume"; task: Task };

const todayIso = () => new Date().toISOString().slice(0, 10);

const blankForm = (modelId: string): Form => ({
  title: "",
  prompt: "",
  modelId,
  webSearch: true,
  frequency: "daily",
  timeOfDay: "08:00",
  dayOfWeek: 1,
  dayOfMonth: 1,
  runOnDate: todayIso(),
});

const formFromTask = (task: Task): Form => ({
  title: task.title,
  prompt: task.prompt,
  modelId: task.modelId,
  webSearch: task.webSearch,
  frequency: task.frequency,
  timeOfDay: task.timeOfDay,
  dayOfWeek: task.dayOfWeek ?? 1,
  dayOfMonth: task.dayOfMonth ?? 1,
  runOnDate: task.runOnDate ?? todayIso(),
});

const requestBody = (form: Form) => ({
  title: form.title,
  prompt: form.prompt,
  modelId: form.modelId,
  webSearch: form.webSearch,
  frequency: form.frequency,
  timeOfDay: form.timeOfDay,
  dayOfWeek: form.frequency === "weekly" ? form.dayOfWeek : null,
  dayOfMonth: form.frequency === "monthly" ? form.dayOfMonth : null,
  runOnDate: form.frequency === "once" ? form.runOnDate : null,
});

const inputClass =
  "mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";
const primaryButton =
  "inline-flex min-h-11 items-center justify-center rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300";
const secondaryButton =
  "inline-flex min-h-11 items-center justify-center rounded-lg border border-zinc-300 px-3 py-2 text-sm font-semibold text-zinc-700 transition-colors hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800";

export function ScheduledTasksSettings() {
  const { lang } = useLanguage();
  const copy = scheduledTasksCopy[lang];
  const { publicModels } = useModelCatalog();
  const models = useMemo(
    () => publicModels.filter((model) => model.usageClass !== "deep-research"),
    [publicModels]
  );
  const defaultModelId = models.some((model) => model.id === DEFAULT_MODEL_ID)
    ? DEFAULT_MODEL_ID
    : models[0]?.id ?? DEFAULT_MODEL_ID;

  const [listing, setListing] = useState<Listing | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [editing, setEditing] = useState<{ taskId: string | null; revision: number | null } | null>(null);
  const [form, setForm] = useState<Form>(() => blankForm(defaultModelId));
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/scheduled-tasks", { cache: "no-store" });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        setLoadFailed(true);
        return;
      }
      setListing((await response.json()) as Listing);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  const errorText = (code: unknown, limit?: unknown) => {
    const messages = copy.errors as Record<string, string>;
    const template = typeof code === "string" && messages[code] ? messages[code] : copy.errors.generic;
    return formatScheduledTasksCopy(template, { limit: typeof limit === "number" ? limit : "" });
  };

  /** One write; a quote request comes back as a confirmation to show. */
  const send = async (
    url: string,
    method: "POST" | "PATCH" | "DELETE",
    body: Record<string, unknown> | null,
    onQuote?: (credits: number) => void
  ) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(url, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (response.ok) return true;
      if (data?.code === "CREDITS_CONFIRMATION_REQUIRED" && typeof data.creditsPerRun === "number" && onQuote) {
        onQuote(data.creditsPerRun);
        return false;
      }
      if (data?.code === "TASK_CHANGED") await load();
      setError(errorText(data?.code, data?.limit));
      return false;
    } catch {
      setError(copy.errors.generic);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const save = async (confirmCredits?: number) => {
    if (!editing) return;
    const body = {
      ...requestBody(form),
      ...(confirmCredits === undefined ? {} : { confirmCredits }),
      ...(editing.taskId ? { expectedRevision: editing.revision } : {}),
    };
    const saved = await send(
      editing.taskId ? `/api/scheduled-tasks/${encodeURIComponent(editing.taskId)}` : "/api/scheduled-tasks",
      editing.taskId ? "PATCH" : "POST",
      body,
      (credits) => setConfirmation({ credits, kind: "save" })
    );
    if (saved) {
      setEditing(null);
      setConfirmation(null);
      await load();
    }
  };

  const setPaused = async (task: Task, paused: boolean, confirmCredits?: number) => {
    const done = await send(
      `/api/scheduled-tasks/${encodeURIComponent(task.id)}`,
      "PATCH",
      {
        action: paused ? "pause" : "resume",
        expectedRevision: task.revision,
        ...(confirmCredits === undefined ? {} : { confirmCredits }),
      },
      (credits) => setConfirmation({ credits, kind: "resume", task })
    );
    if (done) {
      setConfirmation(null);
      await load();
    }
  };

  const remove = async (task: Task) => {
    const done = await send(`/api/scheduled-tasks/${encodeURIComponent(task.id)}`, "DELETE", null);
    if (done) {
      setDeleting(null);
      await load();
    }
  };

  const formatInstant = (iso: string, timeZone: string) => {
    try {
      return new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short", timeZone }).format(new Date(iso));
    } catch {
      return new Date(iso).toLocaleString();
    }
  };

  const scheduleText = (task: Task) => {
    const parts: string[] = [copy.form[task.frequency]];
    if (task.frequency === "weekly" && task.dayOfWeek !== null) parts.push(copy.weekdays[task.dayOfWeek] ?? "");
    if (task.frequency === "monthly" && task.dayOfMonth !== null) parts.push(String(task.dayOfMonth));
    if (task.frequency === "once" && task.runOnDate) parts.push(task.runOnDate);
    parts.push(task.timeOfDay);
    return parts.join(" · ");
  };

  const pauseText = (task: Task) => {
    if (!task.pauseReason) return null;
    const template = (copy.pause as Record<string, string>)[task.pauseReason];
    return template ? formatScheduledTasksCopy(template, { count: SCHEDULED_TASK_LIMITS.maxConsecutiveFailures }) : null;
  };

  const canWrite = Boolean(listing?.enabled && listing.planAllowed);
  const keep = lang === "ko" ? "break-keep [overflow-wrap:anywhere]" : "";

  const openEditor = (task: Task | null) => {
    setError(null);
    setConfirmation(null);
    setForm(task ? formFromTask(task) : blankForm(defaultModelId));
    setEditing({ taskId: task?.id ?? null, revision: task?.revision ?? null });
  };

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-10">
      <SettingsDetailNav section="scheduled-tasks" currentLabel={copy.entry.title} backTestId="scheduled-tasks-back" />
      <h1 className="mt-6 text-2xl font-black">{copy.page.title}</h1>
      <p className={`mt-2 text-sm leading-6 text-zinc-500 dark:text-zinc-400 ${keep}`}>{copy.page.description}</p>
      <p className={`mt-1 text-sm leading-6 text-zinc-500 dark:text-zinc-400 ${keep}`}>{copy.page.runNote}</p>

      {loadFailed && !listing ? <p className="mt-8 text-sm" role="alert">{copy.page.loadFailed}</p> : null}
      {!loadFailed && !listing ? (
        <p className="mt-8 text-sm text-zinc-500" role="status" data-testid="scheduled-tasks-loading">{copy.page.loading}</p>
      ) : null}

      {listing && !listing.enabled ? (
        <p className="mt-8 rounded-xl border border-zinc-200 p-4 text-sm dark:border-zinc-800" data-testid="scheduled-tasks-unavailable">
          {copy.page.unavailable}
        </p>
      ) : null}
      {listing && listing.enabled && !listing.planAllowed ? (
        <p className="mt-8 rounded-xl border border-zinc-200 p-4 text-sm dark:border-zinc-800" data-testid="scheduled-tasks-plan-required">
          {copy.page.planRequired}
        </p>
      ) : null}

      {error ? (
        <p className="mt-6 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-200" role="alert">
          {error}
        </p>
      ) : null}

      {listing && canWrite && !editing ? (
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <button type="button" className={primaryButton} onClick={() => openEditor(null)} data-testid="scheduled-task-create">
            {copy.page.create}
          </button>
          <span className="text-xs text-zinc-500">
            {formatScheduledTasksCopy(copy.page.limitNote, { limit: listing.limits.maxActiveTasks })}
          </span>
        </div>
      ) : null}

      {listing && editing ? (
        <form
          className="mt-8 space-y-4 rounded-2xl border border-zinc-200 p-4 dark:border-zinc-800"
          data-testid="scheduled-task-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label className="block text-sm font-semibold">
            {copy.form.title}
            <input
              className={inputClass}
              value={form.title}
              maxLength={listing.limits.titleCharacters}
              placeholder={copy.form.titlePlaceholder}
              required
              onChange={(event) => { setConfirmation(null); setForm({ ...form, title: event.target.value }); }}
            />
          </label>
          <label className="block text-sm font-semibold">
            {copy.form.prompt}
            <textarea
              className={`${inputClass} min-h-28`}
              value={form.prompt}
              maxLength={listing.limits.promptCharacters}
              placeholder={copy.form.promptPlaceholder}
              required
              onChange={(event) => { setConfirmation(null); setForm({ ...form, prompt: event.target.value }); }}
            />
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm font-semibold">
              {copy.form.model}
              <select
                className={inputClass}
                value={form.modelId}
                onChange={(event) => { setConfirmation(null); setForm({ ...form, modelId: event.target.value }); }}
              >
                {models.map((model) => (
                  <option key={model.id} value={model.id}>{model.name}</option>
                ))}
              </select>
            </label>
            <label className="flex min-h-11 items-center gap-2 self-end text-sm font-semibold">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={form.webSearch}
                onChange={(event) => { setConfirmation(null); setForm({ ...form, webSearch: event.target.checked }); }}
              />
              {copy.form.webSearch}
            </label>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <label className="block text-sm font-semibold">
              {copy.form.frequency}
              <select
                className={inputClass}
                value={form.frequency}
                onChange={(event) => setForm({ ...form, frequency: event.target.value as ScheduledTaskFrequency })}
              >
                {SCHEDULED_TASK_FREQUENCIES.map((frequency) => (
                  <option key={frequency} value={frequency}>{copy.form[frequency]}</option>
                ))}
              </select>
            </label>
            {form.frequency === "weekly" ? (
              <label className="block text-sm font-semibold">
                {copy.form.weekday}
                <select
                  className={inputClass}
                  value={form.dayOfWeek}
                  onChange={(event) => setForm({ ...form, dayOfWeek: Number(event.target.value) })}
                >
                  {copy.weekdays.map((day, index) => <option key={day} value={index}>{day}</option>)}
                </select>
              </label>
            ) : null}
            {form.frequency === "monthly" ? (
              <label className="block text-sm font-semibold">
                {copy.form.dayOfMonth}
                <select
                  className={inputClass}
                  value={form.dayOfMonth}
                  onChange={(event) => setForm({ ...form, dayOfMonth: Number(event.target.value) })}
                >
                  {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => (
                    <option key={day} value={day}>{day}</option>
                  ))}
                </select>
              </label>
            ) : null}
            {form.frequency === "once" ? (
              <label className="block text-sm font-semibold">
                {copy.form.date}
                <input
                  type="date"
                  className={inputClass}
                  value={form.runOnDate}
                  required
                  onChange={(event) => setForm({ ...form, runOnDate: event.target.value })}
                />
              </label>
            ) : null}
            <label className="block text-sm font-semibold">
              {copy.form.time}
              <input
                type="time"
                className={inputClass}
                value={form.timeOfDay}
                required
                onChange={(event) => setForm({ ...form, timeOfDay: event.target.value })}
              />
            </label>
          </div>
          {form.frequency === "monthly" ? <p className="text-xs text-zinc-500">{copy.form.dayOfMonthHint}</p> : null}

          {confirmation?.kind === "save" ? (
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/40" role="status">
              <p className={`text-sm leading-6 text-amber-900 dark:text-amber-100 ${keep}`} data-testid="scheduled-task-credit-quote">
                {formatScheduledTasksCopy(copy.form.confirm, { credits: confirmation.credits })}
              </p>
              <button
                type="button"
                className={`${primaryButton} mt-2`}
                disabled={busy}
                onClick={() => void save(confirmation.credits)}
                data-testid="scheduled-task-confirm-save"
              >
                {copy.form.confirmSave}
              </button>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            {confirmation?.kind !== "save" ? (
              <button type="submit" className={primaryButton} disabled={busy} data-testid="scheduled-task-save">
                {busy ? copy.form.saving : copy.form.save}
              </button>
            ) : null}
            <button
              type="button"
              className={secondaryButton}
              onClick={() => { setEditing(null); setConfirmation(null); setError(null); }}
            >
              {copy.form.cancel}
            </button>
          </div>
        </form>
      ) : null}

      {listing && listing.tasks.length === 0 && !editing ? (
        <p className="mt-8 text-sm text-zinc-500" data-testid="scheduled-tasks-empty">{copy.page.empty}</p>
      ) : null}

      {listing && listing.tasks.length > 0 ? (
        <ul className="mt-8 space-y-3" data-testid="scheduled-task-list">
          {listing.tasks.map((task) => {
            const resultConversation = task.lastRun?.conversationId ?? task.conversationId;
            return (
              <li key={task.id} className="rounded-2xl border border-zinc-200 p-4 dark:border-zinc-800" data-testid="scheduled-task-item">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-bold">{task.title}</p>
                    <p className="mt-0.5 text-xs text-zinc-500">
                      {scheduleText(task)} · {formatScheduledTasksCopy(copy.form.timeZone, { zone: task.timeZone })}
                    </p>
                  </div>
                  <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                    {copy.status[task.status]}
                  </span>
                </div>
                <p className={`mt-2 line-clamp-2 text-sm text-zinc-600 dark:text-zinc-300 ${keep}`}>{task.prompt}</p>
                <p className="mt-2 text-xs text-zinc-500">
                  {task.nextRunAt
                    ? formatScheduledTasksCopy(copy.list.nextRun, { time: formatInstant(task.nextRunAt, task.timeZone) })
                    : copy.list.noNextRun}
                  {" · "}
                  {formatScheduledTasksCopy(copy.list.creditsPerRun, { credits: task.creditsPerRun })}
                </p>
                {task.lastRun ? (
                  <p className="mt-1 text-xs text-zinc-500">
                    {formatScheduledTasksCopy(copy.list.lastRun, {
                      time: formatInstant(task.lastRun.finishedAt ?? task.lastRun.scheduledFor, task.timeZone),
                      status: (copy.run as Record<string, string>)[task.lastRun.status] ?? task.lastRun.status,
                    })}
                  </p>
                ) : null}
                {pauseText(task) ? (
                  <p className={`mt-2 text-sm text-amber-800 dark:text-amber-200 ${keep}`} data-testid="scheduled-task-pause-reason">
                    {pauseText(task)}
                  </p>
                ) : null}

                {confirmation?.kind === "resume" && confirmation.task.id === task.id ? (
                  <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/40" role="status">
                    <p className={`text-sm leading-6 text-amber-900 dark:text-amber-100 ${keep}`}>
                      {formatScheduledTasksCopy(copy.form.confirm, { credits: confirmation.credits })}
                    </p>
                    <button
                      type="button"
                      className={`${primaryButton} mt-2`}
                      disabled={busy}
                      onClick={() => void setPaused(task, false, confirmation.credits)}
                    >
                      {copy.form.confirmResume}
                    </button>
                  </div>
                ) : null}

                {deleting === task.id ? (
                  <div className="mt-3 rounded-xl border border-red-200 p-3 dark:border-red-900" role="alertdialog" aria-label={copy.list.delete}>
                    <p className={`text-sm ${keep}`}>{copy.list.deleteConfirm}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="inline-flex min-h-11 items-center justify-center rounded-lg bg-red-600 px-3 py-2 text-sm font-semibold text-white hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-50"
                        disabled={busy}
                        onClick={() => void remove(task)}
                      >
                        {copy.list.deleteConfirmYes}
                      </button>
                      <button type="button" className={secondaryButton} onClick={() => setDeleting(null)}>
                        {copy.form.cancel}
                      </button>
                    </div>
                  </div>
                ) : null}

                <div className="mt-3 flex flex-wrap gap-2">
                  {resultConversation ? (
                    <Link className={secondaryButton} href={conversationHandoffHref("chat", resultConversation, "/chat")}>
                      {copy.list.openResult}
                    </Link>
                  ) : null}
                  {canWrite ? (
                    <button type="button" className={secondaryButton} disabled={busy} onClick={() => openEditor(task)}>
                      {copy.list.edit}
                    </button>
                  ) : null}
                  {task.status === "active" ? (
                    <button type="button" className={secondaryButton} disabled={busy} onClick={() => void setPaused(task, true)}>
                      {copy.list.pause}
                    </button>
                  ) : canWrite ? (
                    <button type="button" className={secondaryButton} disabled={busy} onClick={() => void setPaused(task, false)}>
                      {copy.list.resume}
                    </button>
                  ) : null}
                  <button type="button" className={secondaryButton} disabled={busy} onClick={() => setDeleting(task.id)}>
                    {copy.list.delete}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
