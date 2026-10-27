"use client";

import type { AdminApiFailure } from "@/lib/adminApiOutcome";
import type { adminAmuxWorkerCapabilityMessages } from "@/lib/adminMessages/amuxWorkerCapability";
import {
  amuxCliModelOptions,
  amuxCliModelStatus,
  type AmuxCliModelCatalogAdminView,
  type AmuxCliModelIssue,
} from "@/lib/amux/cliModelCatalogCore";
import {
  AMUX_WORKER_CAPABILITY_REFUSALS,
  type AmuxWorkerCapability,
  type AmuxWorkerCapabilityAdminRow,
  type AmuxWorkerCapabilityAdminView,
} from "@/lib/amux/workerCapabilityCore";
import {
  amuxWorkerCapabilityFormChanges,
  amuxWorkerCapabilityFormRefusal,
  amuxWorkerCapabilityFromForm,
  amuxWorkerCapabilityIsCustom,
  type AmuxWorkerCapabilityForm,
} from "@/lib/amux/workerCapabilityEditCore";
import { amuxWorkerProfilePresetsFor, type AmuxWorkerProfilePreset } from "@/lib/amux/workerProfilePresetCore";

type Messages = (typeof adminAmuxWorkerCapabilityMessages)["en"];

export type AmuxWorkerCapabilityImport = { workerName: string; expectedRevision: number; capability: AmuxWorkerCapability };
export type AmuxWorkerCapabilityPending = { done: number; total: number } | "reading" | null;
export type AmuxWorkerCapabilityNotice = "done" | "stopped" | "outcome_unknown" | "unread" | null;
export type AmuxWorkerCapabilityRefusalNotice = { workerName: string; code: string } | null;

const buttonClass =
  "inline-flex min-h-11 items-center rounded-md border px-3 py-1 text-xs font-bold disabled:opacity-60 border-zinc-500";

const describe = (m: Messages, capability: AmuxWorkerCapability | null) => {
  if (capability === null) return m.none;
  const parts = [`${m.tags}: ${capability.routingTags.join(", ")}`];
  if (capability.toolCapabilities.length > 0) parts.push(`${m.tools}: ${capability.toolCapabilities.join(", ")}`);
  if (capability.model) parts.push(`${m.model}: ${capability.model}`);
  if (capability.v22) parts.push(`${m.oneShotTasks}: ${capability.v22.roles.join(", ")}`);
  return parts.join(" · ");
};

const inputClass =
  "min-h-11 w-full rounded-md border px-2 py-1 text-base border-zinc-500 bg-zinc-900 text-zinc-100";
const checkLabelClass = "flex min-h-11 items-center gap-2 text-sm text-zinc-200";
const ISSUE_TONE: Readonly<Record<AmuxCliModelIssue, string>> = {
  retired: "border-red-500/40 bg-red-500/10 text-red-300",
  disabled: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  unpriced: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  unlisted: "border-amber-500/40 bg-amber-500/10 text-amber-300",
};

/**
 * What is wrong with a worker's model, as chips: retired or disabled in
 * Tomverse (with the replacement Admin › Models names), not priced, or no
 * longer offered by the CLI. Nothing when it is fine or the catalog is unread.
 */
export function AmuxCliModelIssueChips({
  m,
  cliModels,
  cli,
  model,
  onFix,
}: {
  m: Messages;
  cliModels: AmuxCliModelCatalogAdminView | null;
  cli: string;
  model: string | null;
  /** When given, each chip is a button that opens the editor. */
  onFix?: () => void;
}) {
  if (cliModels === null || model === null || model.length === 0) return null;
  const status = amuxCliModelStatus(cliModels, cli, model);
  if (status.issues.length === 0) return null;
  return (
    <>
      {status.issues.map((issue) => {
        const text = issue === "retired" || issue === "disabled"
          ? m.issue[issue](status.replacement?.name ?? null)
          : m.issue[issue];
        const className = `inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-semibold ${ISSUE_TONE[issue]}`;
        return onFix ? (
          <button key={issue} type="button" className={className} onClick={onFix} data-testid={`amux-cli-model-issue-${issue}`}>
            {text}
          </button>
        ) : (
          <span key={issue} className={className} data-testid={`amux-cli-model-issue-${issue}`}>{text}</span>
        );
      })}
    </>
  );
}

/**
 * The owner's edit form for one worker (version 35 R2a, "Admin 편집"; presets
 * since the owner decision of 2026-10-27). Every control is labelled; the save
 * is held while the store's rule would refuse the form or nothing differs, and
 * the reason is shown before sending.
 */
export function AmuxWorkerCapabilityEditor({
  m,
  row,
  form,
  busy,
  writesLatch,
  cliModels,
  onChange,
  onCancel,
  onSave,
}: {
  m: Messages;
  row: AmuxWorkerCapabilityAdminRow;
  form: AmuxWorkerCapabilityForm;
  busy: boolean;
  writesLatch: boolean;
  /** Each CLI's model names; null when unread, and the model is then typed. */
  cliModels: AmuxCliModelCatalogAdminView | null;
  onChange: (form: AmuxWorkerCapabilityForm) => void;
  onCancel: () => void;
  onSave: (form: AmuxWorkerCapabilityForm) => void;
}) {
  const refusal = amuxWorkerCapabilityFormRefusal(row, form);
  const changes = amuxWorkerCapabilityFormChanges(row, form);
  const id = (field: string) => `amux-worker-capability-edit-${row.workerName}-${field}`;
  const presets = amuxWorkerProfilePresetsFor(row);
  const options = cliModels === null ? [] : amuxCliModelOptions(cliModels, row.providerClass, form.model);
  return (
    <form
      className="flex flex-col gap-3 rounded-md border p-3 border-zinc-600"
      data-testid="amux-worker-capability-editor"
      aria-labelledby={id("title")}
      onSubmit={(event) => {
        event.preventDefault();
        if (refusal === null && changes && !busy && writesLatch) onSave(form);
      }}
    >
      <h3 id={id("title")} className="text-base font-semibold text-zinc-100">{m.editTitle(row.workerName)}</h3>
      <p className="text-sm text-zinc-300">{m.editHelp}</p>
      {amuxWorkerCapabilityIsCustom(row) ? (
        <p className="flex flex-wrap items-center gap-2 text-sm text-amber-300" data-testid="amux-worker-capability-edit-custom">
          <span className="inline-flex items-center rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-xs font-semibold">
            {m.custom}
          </span>
          {m.customHelp}
        </p>
      ) : null}
      <label className="flex flex-col gap-1 text-sm text-zinc-200" htmlFor={id("preset")}>
        {m.field.preset}
        <select
          id={id("preset")}
          className={inputClass}
          value={form.preset}
          onChange={(event) => onChange({ ...form, preset: event.target.value as AmuxWorkerProfilePreset })}
          data-testid="amux-worker-capability-edit-preset"
        >
          {presets.map((preset) => <option key={preset} value={preset}>{m.preset[preset].label}</option>)}
        </select>
        <span className="text-xs text-zinc-400">{m.preset[form.preset].help}</span>
      </label>
      <label className="flex flex-col gap-1 text-sm text-zinc-200" htmlFor={id("model")}>
        {m.field.model}
        {options.length > 0 ? (
          <select
            id={id("model")}
            className={inputClass}
            value={form.model}
            onChange={(event) => onChange({ ...form, model: event.target.value })}
            data-testid="amux-worker-capability-edit-model"
          >
            {form.model.length === 0 ? <option value="">{m.chooseModel}</option> : null}
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label === option.value ? option.value : `${option.label} (${option.value})`}
                {option.issues.length > 0 ? ` · ${option.issues.map((issue) => m.issueShort[issue]).join(", ")}` : ""}
              </option>
            ))}
          </select>
        ) : (
          <input
            id={id("model")}
            className={inputClass}
            value={form.model}
            maxLength={160}
            onChange={(event) => onChange({ ...form, model: event.target.value })}
            data-testid="amux-worker-capability-edit-model"
          />
        )}
        <span className="flex flex-wrap gap-1">
          <AmuxCliModelIssueChips m={m} cliModels={cliModels} cli={row.providerClass} model={form.model} />
        </span>
      </label>
      <label className={checkLabelClass}>
        <input
          type="checkbox"
          className="h-5 w-5"
          checked={form.oneShot}
          onChange={(event) => onChange({ ...form, oneShot: event.target.checked })}
          data-testid="amux-worker-capability-edit-one-shot"
        />
        {m.field.oneShot}
      </label>
      <p className="text-xs text-zinc-400">{form.oneShot ? m.oneShotOnHelp : m.oneShotOffHelp}</p>
      <p className="text-sm text-zinc-300" data-testid="amux-worker-capability-edit-preview">
        {describe(m, amuxWorkerCapabilityFromForm(row, form))}
      </p>
      {refusal ? (
        <p role="alert" className="text-sm text-red-300" data-testid="amux-worker-capability-edit-refusal">
          {m.editRefusal(refusal)}
        </p>
      ) : !changes ? (
        <p className="text-sm text-zinc-300" data-testid="amux-worker-capability-edit-unchanged">{m.editUnchanged}</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          className={buttonClass}
          disabled={busy || !writesLatch || refusal !== null || !changes}
          data-testid="amux-worker-capability-edit-save"
        >
          {busy ? m.saving : m.save}
        </button>
        <button type="button" className={buttonClass} disabled={busy} onClick={onCancel} data-testid="amux-worker-capability-edit-cancel">
          {m.cancel}
        </button>
      </div>
    </form>
  );
}

export type AmuxWorkerCapabilityUpdate = Partial<{
  pending: AmuxWorkerCapabilityPending;
  notice: AmuxWorkerCapabilityNotice;
  refusal: AmuxWorkerCapabilityRefusalNotice;
  failure: AdminApiFailure | null;
  view: AmuxWorkerCapabilityAdminView | null;
}>;

export type AmuxWorkerCapabilityIo = {
  post: (entry: AmuxWorkerCapabilityImport) => Promise<Response>;
  read: () => Promise<AmuxWorkerCapabilityAdminView | null>;
  failureOf: (response: Response) => Promise<AdminApiFailure>;
  networkFailure: () => AdminApiFailure;
};

const NO_WRITE_STATUSES: ReadonlySet<number> = new Set([400, 403, 404, 413, 428, 429]);
const REFUSAL_CODES: ReadonlySet<string> = new Set([
  "capability_writes_off",
  "stale_revision",
  "unreadable_registry",
  ...AMUX_WORKER_CAPABILITY_REFUSALS,
]);

const refusalError = async (response: Response): Promise<unknown> => {
  try {
    const body = (await response.clone().json()) as { error?: unknown } | null;
    return body?.error ?? null;
  } catch {
    return null;
  }
};

/** A 2xx proves only what its body says: this worker's capability at the next revision. */
const isCapabilityReceipt = async (response: Response, entry: AmuxWorkerCapabilityImport): Promise<boolean> => {
  try {
    const body = (await response.json()) as Record<string, unknown> | null;
    return (
      body !== null &&
      typeof body === "object" &&
      body.workerName === entry.workerName &&
      body.revision === entry.expectedRevision + 1 &&
      body.action === "amux.worker.capability" &&
      typeof body.eventId === "string" &&
      body.eventId.length > 0
    );
  } catch {
    return false;
  }
};

/**
 * Records the given imports one by one, each sent once. Only a verified
 * receipt lets the run go on. A refusal or a pre-transaction status wrote
 * nothing and stops the run; any other answer may have written, so nothing
 * more is sent (foundation principle 7). The capabilities are read again
 * before anything is released.
 */
export async function runAmuxWorkerCapabilityImport(
  imports: readonly AmuxWorkerCapabilityImport[],
  io: AmuxWorkerCapabilityIo,
  update: (changes: AmuxWorkerCapabilityUpdate) => void,
): Promise<void> {
  update({ pending: { done: 0, total: imports.length }, notice: null, refusal: null, failure: null });
  try {
    let outcome: "done" | "stopped" | "outcome_unknown" = "done";
    for (const [index, entry] of imports.entries()) {
      let response: Response;
      try {
        response = await io.post(entry);
      } catch {
        update({ failure: io.networkFailure() });
        outcome = "outcome_unknown";
        break;
      }
      if (response.ok) {
        if (await isCapabilityReceipt(response, entry)) {
          update({ pending: { done: index + 1, total: imports.length } });
          continue;
        }
        outcome = "outcome_unknown";
        break;
      }
      const error = await refusalError(response);
      if (response.status === 409 && typeof error === "string" && REFUSAL_CODES.has(error)) {
        update({ refusal: { workerName: entry.workerName, code: error } });
        outcome = "stopped";
      } else if (NO_WRITE_STATUSES.has(response.status) || response.status === 409 ||
                 (response.status === 503 && error === "capability_change_failed")) {
        update({ failure: await io.failureOf(response) });
        outcome = "stopped";
      } else {
        outcome = "outcome_unknown";
      }
      break;
    }
    update({ pending: "reading" });
    const view = await io.read();
    update({ view, notice: view === null ? "unread" : outcome });
  } finally {
    update({ pending: null });
  }
}

export async function runAmuxWorkerCapabilityReread(
  io: Pick<AmuxWorkerCapabilityIo, "read">,
  update: (changes: AmuxWorkerCapabilityUpdate) => void,
): Promise<void> {
  update({ pending: "reading", failure: null });
  try {
    const view = await io.read();
    update(view === null ? { view } : { view, notice: null, refusal: null });
  } finally {
    update({ pending: null });
  }
}

/**
 * Records one edited capability, sent once, with the same rules as the
 * import: a verified receipt, a refusal that stops, an unclear answer that
 * sends nothing more, and a read-back before anything is released. True
 * when the change was recorded and read back.
 */
export async function runAmuxWorkerCapabilityEdit(
  row: AmuxWorkerCapabilityAdminRow,
  form: AmuxWorkerCapabilityForm,
  io: AmuxWorkerCapabilityIo,
  update: (changes: AmuxWorkerCapabilityUpdate) => void,
): Promise<boolean> {
  let notice: AmuxWorkerCapabilityNotice = null;
  await runAmuxWorkerCapabilityImport(
    [{ workerName: form.workerName, expectedRevision: form.expectedRevision, capability: amuxWorkerCapabilityFromForm(row, form) }],
    io,
    (changes) => {
      if ("notice" in changes) notice = changes.notice ?? null;
      update(changes);
    },
  );
  return notice === "done";
}
