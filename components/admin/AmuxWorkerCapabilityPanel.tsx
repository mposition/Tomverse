"use client";

import type { AdminApiFailure } from "@/lib/adminApiOutcome";
import type { adminAmuxWorkerCapabilityMessages } from "@/lib/adminMessages/amuxWorkerCapability";
import {
  AMUX_WORKER_CAPABILITY_REFUSALS,
  AMUX_WORKER_ROUTING_TAG_REQUIREMENTS,
  AMUX_WORKER_ROUTING_TAGS,
  AMUX_WORKER_V22_ROLE_REQUIREMENTS,
  AMUX_WORKER_V22_ROLES,
  AMUX_WORKER_V22_TOOLS,
  type AmuxWorkerCapability,
  type AmuxWorkerCapabilityAdminRow,
  type AmuxWorkerCapabilityAdminView,
} from "@/lib/amux/workerCapabilityCore";
import {
  amuxToggleListValue,
  amuxWorkerCapabilityFormChanges,
  amuxWorkerCapabilityFormRefusal,
  amuxWorkerCapabilityFromForm,
  type AmuxWorkerCapabilityForm,
} from "@/lib/amux/workerCapabilityEditCore";

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
  if (capability.v22) parts.push(`${m.v22}: ${capability.v22.roles.join(", ")} (${capability.v22.tools.join(", ")}, ${capability.v22.model})`);
  return parts.join(" · ");
};

const inputClass =
  "min-h-11 w-full rounded-md border px-2 py-1 text-base border-zinc-500 bg-zinc-900 text-zinc-100";
const checkLabelClass = "flex min-h-11 items-center gap-2 text-sm text-zinc-200";

/**
 * The owner's edit form for one worker (version 35 R2a, "Admin 편집"). Every
 * control is labelled; the save is held while the store's rule would refuse
 * the form or nothing differs, and the reason is shown before sending.
 */
export function AmuxWorkerCapabilityEditor({
  m,
  row,
  form,
  busy,
  writesLatch,
  onChange,
  onCancel,
  onSave,
}: {
  m: Messages;
  row: AmuxWorkerCapabilityAdminRow;
  form: AmuxWorkerCapabilityForm;
  busy: boolean;
  writesLatch: boolean;
  onChange: (form: AmuxWorkerCapabilityForm) => void;
  onCancel: () => void;
  onSave: (form: AmuxWorkerCapabilityForm) => void;
}) {
  const refusal = amuxWorkerCapabilityFormRefusal(row, form);
  const changes = amuxWorkerCapabilityFormChanges(row, form);
  const id = (field: string) => `amux-worker-capability-edit-${row.workerName}-${field}`;
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
      <label className="flex flex-col gap-1 text-sm text-zinc-200" htmlFor={id("model")}>
        {m.field.model}
        <input
          id={id("model")}
          className={inputClass}
          value={form.model}
          maxLength={160}
          onChange={(event) => onChange({ ...form, model: event.target.value })}
          data-testid="amux-worker-capability-edit-model"
        />
      </label>
      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm font-semibold text-zinc-100">{m.field.tags}</legend>
        <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
          {AMUX_WORKER_ROUTING_TAGS.map((tag) => (
            <label key={tag} className={checkLabelClass}>
              <input
                type="checkbox"
                className="h-5 w-5"
                checked={form.routingTags.includes(tag)}
                onChange={(event) => onChange({ ...form, routingTags: amuxToggleListValue(form.routingTags, tag, event.target.checked) })}
                data-testid={`amux-worker-capability-edit-tag-${tag}`}
              />
              <span className="font-mono text-xs">{tag}</span>
              <span className="text-xs text-zinc-400">{m.requirement[AMUX_WORKER_ROUTING_TAG_REQUIREMENTS[tag]!]}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="flex flex-col gap-1 text-sm text-zinc-200" htmlFor={id("tools")}>
        {m.field.tools}
        <input
          id={id("tools")}
          className={inputClass}
          value={form.tools}
          onChange={(event) => onChange({ ...form, tools: event.target.value })}
          data-testid="amux-worker-capability-edit-tools"
        />
      </label>
      <label className={checkLabelClass}>
        <input
          type="checkbox"
          className="h-5 w-5"
          checked={form.v22Enabled}
          onChange={(event) => onChange({ ...form, v22Enabled: event.target.checked })}
          data-testid="amux-worker-capability-edit-v22"
        />
        {m.field.v22}
      </label>
      {form.v22Enabled ? (
        <div className="flex flex-col gap-3 border-l-2 pl-3 border-zinc-600">
          <label className="flex flex-col gap-1 text-sm text-zinc-200" htmlFor={id("v22-model")}>
            {m.field.v22Model}
            <input
              id={id("v22-model")}
              className={inputClass}
              value={form.v22Model}
              maxLength={160}
              onChange={(event) => onChange({ ...form, v22Model: event.target.value })}
              data-testid="amux-worker-capability-edit-v22-model"
            />
          </label>
          <fieldset className="flex flex-col gap-1">
            <legend className="text-sm font-semibold text-zinc-100">{m.field.v22Roles}</legend>
            {AMUX_WORKER_V22_ROLES.map((role) => (
              <label key={role} className={checkLabelClass}>
                <input
                  type="checkbox"
                  className="h-5 w-5"
                  checked={form.v22Roles.includes(role)}
                  onChange={(event) => onChange({ ...form, v22Roles: amuxToggleListValue(form.v22Roles, role, event.target.checked) })}
                  data-testid={`amux-worker-capability-edit-v22-role-${role}`}
                />
                <span className="font-mono text-xs">{role}</span>
                <span className="text-xs text-zinc-400">{m.requirement[AMUX_WORKER_V22_ROLE_REQUIREMENTS[role]!]}</span>
              </label>
            ))}
          </fieldset>
          <fieldset className="flex flex-col gap-1">
            <legend className="text-sm font-semibold text-zinc-100">{m.field.v22Tools}</legend>
            {AMUX_WORKER_V22_TOOLS.map((tool) => (
              <label key={tool} className={checkLabelClass}>
                <input
                  type="checkbox"
                  className="h-5 w-5"
                  checked={form.v22Tools.includes(tool)}
                  onChange={(event) => onChange({ ...form, v22Tools: amuxToggleListValue(form.v22Tools, tool, event.target.checked) })}
                  data-testid={`amux-worker-capability-edit-v22-tool-${tool}`}
                />
                <span className="font-mono text-xs">{tool}</span>
              </label>
            ))}
          </fieldset>
        </div>
      ) : null}
      <p className="text-sm text-zinc-300" data-testid="amux-worker-capability-edit-preview">
        {describe(m, amuxWorkerCapabilityFromForm(form))}
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
  form: AmuxWorkerCapabilityForm,
  io: AmuxWorkerCapabilityIo,
  update: (changes: AmuxWorkerCapabilityUpdate) => void,
): Promise<boolean> {
  let notice: AmuxWorkerCapabilityNotice = null;
  await runAmuxWorkerCapabilityImport(
    [{ workerName: form.workerName, expectedRevision: form.expectedRevision, capability: amuxWorkerCapabilityFromForm(form) }],
    io,
    (changes) => {
      if ("notice" in changes) notice = changes.notice ?? null;
      update(changes);
    },
  );
  return notice === "done";
}
