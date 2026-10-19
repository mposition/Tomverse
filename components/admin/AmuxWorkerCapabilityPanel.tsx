"use client";

import { useState } from "react";

import { AdminApiFailureNotice } from "@/components/admin/AdminApiFailureNotice";
import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import {
  adminNetworkFailure,
  readAdminApiFailure,
  type AdminApiFailure,
} from "@/lib/adminApiOutcome";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxWorkerCapabilityMessages } from "@/lib/adminMessages/amuxWorkerCapability";
import {
  AMUX_WORKER_CAPABILITY_REFUSALS,
  AMUX_WORKER_ROUTING_TAG_REQUIREMENTS,
  AMUX_WORKER_ROUTING_TAGS,
  AMUX_WORKER_V22_ROLE_REQUIREMENTS,
  AMUX_WORKER_V22_ROLES,
  AMUX_WORKER_V22_TOOLS,
  parseAmuxWorkerCapabilityAdminView,
  type AmuxWorkerCapability,
  type AmuxWorkerCapabilityAdminRow,
  type AmuxWorkerCapabilityAdminView,
} from "@/lib/amux/workerCapabilityCore";
import {
  amuxToggleListValue,
  amuxWorkerCapabilityFormChanges,
  amuxWorkerCapabilityFormFromRow,
  amuxWorkerCapabilityFormRefusal,
  amuxWorkerCapabilityFromForm,
  type AmuxWorkerCapabilityForm,
} from "@/lib/amux/workerCapabilityEditCore";

const CAPABILITY_PATH = "/api/admin/amux/workers/capabilities";

type Messages = (typeof adminAmuxWorkerCapabilityMessages)["en"];

export type AmuxWorkerCapabilityImport = { workerName: string; expectedRevision: number; capability: AmuxWorkerCapability };
export type AmuxWorkerCapabilityPending = { done: number; total: number } | "reading" | null;
export type AmuxWorkerCapabilityNotice = "done" | "stopped" | "outcome_unknown" | "unread" | null;
export type AmuxWorkerCapabilityRefusalNotice = { workerName: string; code: string } | null;

const cellClass = "border-b px-2 py-2 align-top border-zinc-700";
const headClass = `${cellClass} text-xs font-semibold text-zinc-400`;
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

/**
 * The capability section of AMUX › Execution › Workers, without hooks, so a
 * test can call it and read the tree it returns. It shows each registered
 * worker's recorded capability; the owner edits one worker at a time. Stage
 * R2a's import from the catalog variables went with the variables at R2e.
 */
export function AmuxWorkerCapabilityView({
  m,
  view,
  isOwner,
  pending,
  notice,
  refusal,
  failure,
  onReread,
  editing = null,
  onEditStart = () => {},
  onEditChange = () => {},
  onEditCancel = () => {},
  onEditSave = () => {},
}: {
  m: Messages;
  view: AmuxWorkerCapabilityAdminView | null;
  isOwner: boolean;
  pending: AmuxWorkerCapabilityPending;
  notice: AmuxWorkerCapabilityNotice;
  refusal: AmuxWorkerCapabilityRefusalNotice;
  failure: AdminApiFailure | null;
  onReread: () => void;
  /** The form being edited, or null; the owner edits one worker at a time. */
  editing?: AmuxWorkerCapabilityForm | null;
  onEditStart?: (row: AmuxWorkerCapabilityAdminRow) => void;
  onEditChange?: (form: AmuxWorkerCapabilityForm) => void;
  onEditCancel?: () => void;
  onEditSave?: (form: AmuxWorkerCapabilityForm) => void;
}) {
  const busy = pending !== null;
  return (
    <section className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4" data-testid="amux-worker-capability-panel">
      <h2 className="text-lg font-semibold text-zinc-100">{m.title}</h2>
      <p className="text-sm text-zinc-300">{m.description}</p>
      {view === null ? (
        <div className="flex flex-col gap-2">
          <p role="alert" className="text-sm text-red-300" data-testid="amux-worker-capability-unavailable">
            {m.unavailable}
          </p>
          <button type="button" className={`${buttonClass} w-fit`} disabled={busy} onClick={onReread} data-testid="amux-worker-capability-reread">
            {pending === "reading" ? m.reading : m.reread}
          </button>
        </div>
      ) : (
        <>
          <p className="text-sm text-zinc-300" data-testid="amux-worker-capability-latch">
            {view.writesLatch ? m.writesOn : m.writesOff}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm text-zinc-100">
              <thead>
                <tr>
                  <th scope="col" className={headClass}>{m.column.worker}</th>
                  <th scope="col" className={headClass}>{m.column.ceiling}</th>
                  <th scope="col" className={headClass}>{m.column.current}</th>
                  {isOwner ? <th scope="col" className={headClass}><span className="sr-only">{m.edit}</span></th> : null}
                </tr>
              </thead>
              <tbody>
                {view.rows.map((row) => (
                  <tr key={row.workerName} data-testid={`amux-worker-capability-row-${row.workerName}`}>
                    <th scope="row" className={`${cellClass} font-mono text-xs`}>{row.workerName}</th>
                    <td className={cellClass}>{row.roleCeiling}</td>
                    <td className={cellClass}>{describe(m, row.current?.capability ?? null)}</td>
                    {isOwner ? (
                      <td className={cellClass}>
                        <button
                          type="button"
                          className={buttonClass}
                          aria-label={m.editLabel(row.workerName)}
                          disabled={busy || !view.writesLatch || row.desiredState === "retired" || editing !== null}
                          onClick={() => onEditStart(row)}
                          data-testid={`amux-worker-capability-edit-${row.workerName}`}
                        >
                          {m.edit}
                        </button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {isOwner && editing !== null ? (() => {
            const row = view.rows.find((candidate) => candidate.workerName === editing.workerName);
            return row ? (
              <AmuxWorkerCapabilityEditor
                m={m}
                row={row}
                form={editing}
                busy={busy}
                writesLatch={view.writesLatch}
                onChange={onEditChange}
                onCancel={onEditCancel}
                onSave={onEditSave}
              />
            ) : null;
          })() : null}
        </>
      )}
      {notice === "done" ? <p role="status" className="text-sm" data-testid="amux-worker-capability-done">{m.importDone}</p> : null}
      {notice === "stopped" ? <p role="status" className="text-sm" data-testid="amux-worker-capability-stopped">{m.importStopped}</p> : null}
      {notice === "outcome_unknown" ? (
        <p role="alert" className="text-sm text-amber-300" data-testid="amux-worker-capability-outcome-unknown">{m.importOutcomeUnknown}</p>
      ) : null}
      {notice === "unread" ? (
        <p role="alert" className="text-sm text-amber-300" data-testid="amux-worker-capability-run-unread">{m.importUnread}</p>
      ) : null}
      {refusal ? (
        <p role="alert" className="text-sm text-red-300" data-testid="amux-worker-capability-refused">
          {m.importRefused(refusal.workerName, refusal.code)}
        </p>
      ) : null}
      {failure ? <AdminApiFailureNotice failure={failure} /> : null}
    </section>
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

/**
 * The view with its requests. A capability write needs the owner role, R2a's
 * code latch and a recent step-up, all checked by the route; a stale step-up
 * is answered 428 and rendered with the way back (`AdminApiFailureNotice`,
 * docs/ui-contracts/admin-console-ia.md rule 7).
 */
export function AmuxWorkerCapabilityPanel({ view, isOwner }: { view: AmuxWorkerCapabilityAdminView | null; isOwner: boolean }) {
  const m = useAdminMessages(adminAmuxWorkerCapabilityMessages) as Messages;
  const { locale } = useAdminLocale();
  const [current, setCurrent] = useState<AmuxWorkerCapabilityAdminView | null>(view);
  const [pending, setPending] = useState<AmuxWorkerCapabilityPending>(null);
  const [notice, setNotice] = useState<AmuxWorkerCapabilityNotice>(null);
  const [refusal, setRefusal] = useState<AmuxWorkerCapabilityRefusalNotice>(null);
  const [failure, setFailure] = useState<AdminApiFailure | null>(null);
  const [editing, setEditing] = useState<AmuxWorkerCapabilityForm | null>(null);

  const apply = (changes: AmuxWorkerCapabilityUpdate) => {
    if ("view" in changes) {
      const next = changes.view ?? null;
      setCurrent(next);
      // A worker that left the list (retired elsewhere) cannot be edited, and
      // its editor would no longer render a way out: let the edit go.
      if (next !== null) {
        setEditing((form) => (form !== null && next.rows.some((row) => row.workerName === form.workerName) ? form : null));
      }
    }
    if ("notice" in changes) setNotice(changes.notice ?? null);
    if ("refusal" in changes) setRefusal(changes.refusal ?? null);
    if ("failure" in changes) setFailure(changes.failure ?? null);
    if ("pending" in changes) setPending(changes.pending ?? null);
  };

  const io: AmuxWorkerCapabilityIo = {
    post: (entry) =>
      adminFetch(CAPABILITY_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(entry),
      }),
    read: async () => {
      try {
        const response = await adminFetch(CAPABILITY_PATH, { method: "GET" });
        return response.ok ? parseAmuxWorkerCapabilityAdminView(await response.json().catch(() => null)) : null;
      } catch {
        return null;
      }
    },
    failureOf: (response) => readAdminApiFailure(response, { fallback: m.changeFailed, locale }),
    networkFailure: () => adminNetworkFailure(locale),
  };

  return (
    <AmuxWorkerCapabilityView
      m={m}
      view={current}
      isOwner={isOwner}
      pending={pending}
      notice={notice}
      refusal={refusal}
      failure={failure}
      onReread={() => void runAmuxWorkerCapabilityReread(io, apply)}
      editing={editing}
      onEditStart={(row) => setEditing(amuxWorkerCapabilityFormFromRow(row))}
      onEditChange={setEditing}
      onEditCancel={() => setEditing(null)}
      onEditSave={(form) =>
        void runAmuxWorkerCapabilityEdit(form, io, apply).then((saved) => {
          if (saved) setEditing(null);
        })}
    />
  );
}
