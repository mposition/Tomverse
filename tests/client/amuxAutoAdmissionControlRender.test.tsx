import assert from "node:assert/strict";
import test from "node:test";
import type { ReactNode } from "react";
import { AmuxAutoAdmissionControlView } from "@/components/admin/AmuxV22PromotionControl";
import { AdminApiFailureNotice } from "@/components/admin/AdminApiFailureNotice";
import { describeAdminApiFailure, readAdminApiFailure } from "@/lib/adminApiOutcome";
import { adminAmuxAutoAdmissionMessages } from "@/lib/adminMessages/amuxAutoAdmission";
import {
  amuxAutoAdmissionChangeBody,
  amuxAutoAdmissionWriteLocked,
  parseAmuxAutoAdmissionControl,
  runAmuxAutoAdmissionChange,
  runAmuxAutoAdmissionRead,
  type AmuxAutoAdmissionControl,
  type AmuxAutoAdmissionIo,
  type AmuxAutoAdmissionNotice,
  type AmuxAutoAdmissionUpdate,
} from "@/lib/amux/autoAdmissionControlCore";

const CONTROL: AmuxAutoAdmissionControl = {
  codeLatch: true, environmentEnabled: true, active: false,
  authorizationAuditLogId: "audit-before",
  graduation: { ok: false, count: 0, spanMs: 0 },
  graduationExceptionId: "owner-bootstrap-2026-10-11",
  graduationExceptionAvailable: true, graduationExceptionApplied: false,
};
const m = adminAmuxAutoAdmissionMessages.en;
const json = (status: number, body: unknown) => Response.json(body, { status });
const failure = describeAdminApiFailure({ status: 503, fallback: "read failed" });

function harness(overrides: Partial<AmuxAutoAdmissionIo> = {}) {
  const updates: AmuxAutoAdmissionUpdate[] = [];
  const bodies: ReturnType<typeof amuxAutoAdmissionChangeBody>[] = [];
  let reads = 0;
  const io: AmuxAutoAdmissionIo = {
    post: async (body) => { bodies.push(body); return json(200, {
      active: body.active, authorizationAuditLogId: "audit-after", changed: true,
    }); },
    read: async () => { reads += 1; return { control: { ...CONTROL,
      active: true, authorizationAuditLogId: "audit-after" }, failure: null }; },
    failureOf: (response) => readAdminApiFailure(response, { fallback: m.changeFailed }),
    networkFailure: () => failure,
    ...overrides,
  };
  return { io, updates, bodies, readCount: () => reads,
    update: (change: AmuxAutoAdmissionUpdate) => updates.push(change) };
}
const change = (notice: AmuxAutoAdmissionNotice = null) => ({
  active: true, control: CONTROL, confirmed: true, notice, pending: null,
});
type Props = Record<string, unknown>;
function propsOf(node: ReactNode, found: Props[] = []): Props[] {
  if (node === null || node === undefined || typeof node === "boolean" ||
      typeof node === "string" || typeof node === "number") return found;
  if (Array.isArray(node)) { for (const child of node) propsOf(child, found); return found; }
  const element = node as { props?: Props; type?: unknown };
  if (element.props) {
    found.push({ ...element.props, elementType: element.type });
    propsOf(element.props.children as ReactNode, found);
  }
  return found;
}
function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  return textOf((node as { props?: { children?: ReactNode } }).props?.children);
}
const byId = (node: ReactNode, id: string) => propsOf(node).find((props) => props["data-testid"] === id);
type ViewProps = Parameters<typeof AmuxAutoAdmissionControlView>[0];
const render = (overrides: Partial<ViewProps> = {}) => AmuxAutoAdmissionControlView({
  m, control: CONTROL, pending: null, notice: null, failure: null, confirmed: false,
  onConfirmChange: () => {}, onConfigure: () => {}, onRead: () => {}, ...overrides,
});

test("control reads reject missing, malformed and unrecognised evidence without inventing an off state", () => {
  assert.deepEqual(parseAmuxAutoAdmissionControl({ ...CONTROL, activatedAt: null }), CONTROL);
  for (const value of [null, [], {}, { ...CONTROL, active: "false" },
    { ...CONTROL, authorizationAuditLogId: "" },
    { ...CONTROL, graduation: { ok: false, count: -1, spanMs: 0 } },
    { ...CONTROL, graduation: { ok: false, count: 0, spanMs: Infinity } },
    { ...CONTROL, graduation: { ok: false, count: 0 } },
    { ...CONTROL, graduationExceptionId: "enabled" },
    { ...CONTROL, graduationExceptionApplied: undefined }]) {
    assert.equal(parseAmuxAutoAdmissionControl(value), null);
  }
});

test("CAS and the exact bootstrap exception travel only under the existing activation condition", () => {
  assert.deepEqual(amuxAutoAdmissionChangeBody(true, CONTROL), {
    policyVersion: 22, active: true, expectedAuditLogId: "audit-before",
    graduationExceptionId: "owner-bootstrap-2026-10-11",
  });
  assert.deepEqual(amuxAutoAdmissionChangeBody(false, CONTROL), {
    policyVersion: 22, active: false, expectedAuditLogId: "audit-before",
  });
  assert.equal("graduationExceptionId" in amuxAutoAdmissionChangeBody(true,
    { ...CONTROL, graduationExceptionAvailable: false }), false);
});

test("activation requires explicit confirmation and reported local gates; a stop remains available while they close", async () => {
  for (const input of [{ ...change(), confirmed: false }, { ...change(), control: null },
    { ...change(), control: { ...CONTROL, codeLatch: false } },
    { ...change(), control: { ...CONTROL, environmentEnabled: false } },
    { ...change(), control: { ...CONTROL, graduationExceptionAvailable: false } },
    { ...change(), pending: "reading" as const }, change("outcome_unknown")]) {
    const h = harness();
    await runAmuxAutoAdmissionChange(input, h.io, h.update);
    assert.equal(h.bodies.length, 0);
  }
  const h = harness();
  await runAmuxAutoAdmissionChange({ ...change(), active: false, confirmed: false,
    control: { ...CONTROL, active: true, codeLatch: false, environmentEnabled: false } }, h.io, h.update);
  assert.equal(h.bodies.length, 1);
  assert.equal(h.bodies[0]!.active, false);
});

test("an acknowledged write is sent once, clears stale state and rereads before unlocking", async () => {
  const h = harness();
  await runAmuxAutoAdmissionChange(change(), h.io, h.update);
  assert.equal(h.bodies.length, 1);
  assert.equal(h.readCount(), 1);
  assert.equal(h.updates[0]!.pending, "activating");
  assert.equal(h.updates[0]!.confirmed, false);
  assert.ok(h.updates.some((update) => update.control === null && update.notice === "saved"));
  assert.ok(h.updates.some((update) => update.control?.authorizationAuditLogId === "audit-after"));
  assert.equal(h.updates.at(-1)!.pending, null);
});

test("428 is a canonical recent-authentication refusal without resending or a read-back", async () => {
  const h = harness({ post: async () => json(428, { code: "ADMIN_REAUTHENTICATION_REQUIRED" }) });
  await runAmuxAutoAdmissionChange(change(), h.io, h.update);
  assert.equal(h.readCount(), 0);
  const refusal = h.updates.find((update) => update.failure)?.failure;
  assert.equal(refusal?.requiresReauthentication, true);
  assert.equal(h.updates.some((update) => update.control === null), false);
  const tree = render({ failure: refusal! });
  const refusalElement = propsOf(tree).find((props) => props.failure === refusal);
  assert.equal(refusalElement?.elementType, AdminApiFailureNotice);
});

test("a conflict removes the stale CAS until a safe read restores current state", async () => {
  const h = harness({ post: async () => json(409, { error: "conflict" }) });
  await runAmuxAutoAdmissionChange(change(), h.io, h.update);
  assert.ok(h.updates.some((update) => update.notice === "conflict" && update.control === null));
  assert.equal(h.readCount(), 0);
  await runAmuxAutoAdmissionRead(h.io, h.update, "conflict");
  assert.ok(h.updates.some((update) => update.control?.authorizationAuditLogId === "audit-after" &&
    update.notice === null));
});

test("unknown responses never retry; a successful state read keeps the write lock", async () => {
  for (const post of [async () => json(503, { error: "outcome_unknown" }),
    async () => json(409, { error: "outcome_unknown" }),
    async () => json(409, { error: "unrecognised" }),
    async () => json(408, {}), async () => new Response("not JSON", { status: 200 }),
    async () => json(200, { active: true }), async () => { throw new Error("lost response"); }]) {
    let posts = 0;
    const h = harness({ post: async () => { posts += 1; return post(); } });
    await runAmuxAutoAdmissionChange(change(), h.io, h.update);
    assert.equal(posts, 1);
    assert.equal(h.readCount(), 0);
    assert.ok(h.updates.some((update) => update.notice === "outcome_unknown_unread"));
    await runAmuxAutoAdmissionRead(h.io, h.update, "outcome_unknown_unread");
    const readBack = h.updates.findLast((update) => update.control !== undefined);
    assert.equal(readBack?.notice, "outcome_unknown");
    assert.equal(amuxAutoAdmissionWriteLocked(readBack!.notice!), true);
    await runAmuxAutoAdmissionChange(change(readBack!.notice!), h.io, h.update);
    assert.equal(posts, 1);
  }
});

test("a failed read after a confirmed write reports saved-unread, never failed or unknown", async () => {
  const h = harness({ read: async () => ({ control: null, failure }) });
  await runAmuxAutoAdmissionChange(change(), h.io, h.update);
  assert.equal(h.bodies.length, 1);
  assert.ok(h.updates.some((update) => update.notice === "saved_unread" && update.control === null));
  assert.equal(h.updates.some((update) => amuxAutoAdmissionWriteLocked(update.notice ?? null)), false);
  const tree = render({ control: null, notice: "saved_unread", failure });
  assert.equal(byId(tree, "amux-auto-admission-activate"), undefined);
  assert.match(textOf(tree), /server confirmed the change/i);
});

test("a confirmed write does not claim read-back completion while its GET is still pending", () => {
  const pending = render({ control: null, notice: "saved", pending: "reading" });
  assert.equal(byId(pending, "amux-auto-admission-saved"), undefined);
  assert.equal(textOf(pending).includes(m.saved), false);
  const completed = render({ notice: "saved", pending: null });
  assert.ok(byId(completed, "amux-auto-admission-saved"));
  assert.ok(textOf(completed).includes(m.saved));
});

test("an initial failed read has no activation action and no fabricated graduation measurement", async () => {
  const h = harness({ read: async () => ({ control: null, failure }) });
  await runAmuxAutoAdmissionRead(h.io, h.update);
  assert.ok(h.updates.some((update) => update.notice === "load_failed"));
  const tree = render({ control: null, notice: "load_failed", failure });
  assert.equal(byId(tree, "amux-auto-admission-activate"), undefined);
  assert.equal(textOf(byId(tree, "amux-auto-admission-measurement")!.children as ReactNode), m.unreadable);
});

test("English and Korean distinguish measured graduation from available and applied exceptions", () => {
  for (const catalog of [adminAmuxAutoAdmissionMessages.en, adminAmuxAutoAdmissionMessages.ko]) {
    const available = textOf(render({ m: catalog }));
    assert.ok(available.includes(catalog.graduationUnmet));
    assert.ok(available.includes(catalog.exceptionAvailable));
    assert.ok(available.includes(catalog.graduationMeasurement(0, 0)));
    assert.equal(available.includes(catalog.graduationMet), false);
    const applied = render({ m: catalog, control: { ...CONTROL,
      active: true, graduationExceptionApplied: true } });
    assert.ok(textOf(applied).includes(catalog.exceptionApplied));
    assert.ok(textOf(applied).includes(catalog.graduationUnmet));
    assert.equal(byId(applied, "amux-auto-admission-confirmation"), undefined);
    assert.equal(byId(applied, "amux-auto-admission-stop")!.disabled, false);
  }
});

test("checkbox approval and local gates control activation while the label owns the touch target", () => {
  assert.equal(byId(render(), "amux-auto-admission-activate")!.disabled, true);
  const tree = render({ confirmed: true });
  assert.equal(byId(tree, "amux-auto-admission-activate")!.disabled, false);
  const input = byId(tree, "amux-auto-admission-confirmation")!;
  const label = propsOf(tree).find((props) => props.htmlFor === input.id)!;
  assert.match(label.className as string, /min-h-11/);
  assert.equal(input["aria-describedby"], "amux-auto-admission-confirmation-help");
  for (const control of [{ ...CONTROL, codeLatch: false }, { ...CONTROL, environmentEnabled: false }]) {
    assert.equal(byId(render({ control, confirmed: true }), "amux-auto-admission-activate")!.disabled, true);
  }
});

test("busy and unknown writes disable mutation; unknown keeps safe reads available", () => {
  const active = { ...CONTROL, active: true, graduationExceptionApplied: true,
    environmentEnabled: false, codeLatch: false };
  assert.equal(byId(render({ control: active }), "amux-auto-admission-stop")!.disabled, false);
  for (const pending of ["reading", "activating", "stopping"] as const) {
    const tree = render({ control: active, pending });
    assert.equal(byId(tree, "amux-auto-admission-stop")!.disabled, true);
    assert.equal(byId(tree, "amux-auto-admission-reread")!.disabled, true);
  }
  const unknown = render({ control: active, notice: "outcome_unknown" });
  assert.equal(byId(unknown, "amux-auto-admission-stop")!.disabled, true);
  assert.equal(byId(unknown, "amux-auto-admission-reread")!.disabled, false);
  assert.ok(byId(unknown, "amux-auto-admission-outcome-unknown"));
});
