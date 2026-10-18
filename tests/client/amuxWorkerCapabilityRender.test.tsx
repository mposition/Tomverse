import assert from "node:assert/strict";
import test from "node:test";

import type { ReactNode } from "react";

import {
  AmuxWorkerCapabilityView,
  runAmuxWorkerCapabilityReread,
  type AmuxWorkerCapabilityIo,
  type AmuxWorkerCapabilityUpdate,
} from "@/components/admin/AmuxWorkerCapabilityPanel";
import type { AdminApiFailure } from "@/lib/adminApiOutcome";
import { adminAmuxWorkerCapabilityMessages } from "@/lib/adminMessages/amuxWorkerCapability";
import {
  buildAmuxWorkerCapabilityAdminView,
  type AmuxWorkerCapabilityAdminView,
} from "@/lib/amux/workerCapabilityCore";
import { AMUX_WORKER_REGISTRY_V31_SEED, amuxWorkerProviderClassOf } from "@/lib/amux/workerRegistryCore";

/**
 * AMUX › Execution › Workers, capabilities (orchestration policy version 35,
 * section 2), executed: the hook-free view is walked, and the re-read is
 * driven with a fake io. What it shows, and what a failed read leaves.
 */

const m = adminAmuxWorkerCapabilityMessages.en;
type Props = Record<string, unknown>;

const propsOf = (node: ReactNode, found: Props[] = []) => {
  if (node === null || node === undefined || typeof node === "boolean") return found;
  if (typeof node === "string" || typeof node === "number") return found;
  if (Array.isArray(node)) {
    for (const child of node) propsOf(child, found);
    return found;
  }
  const element = node as { props?: Props };
  if (element.props) {
    found.push(element.props);
    propsOf(element.props.children as ReactNode, found);
  }
  return found;
};
const textOf = (node: ReactNode): string => {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  const element = node as { props?: { children?: ReactNode } };
  return element.props ? textOf(element.props.children) : "";
};
const byTestId = (node: ReactNode, id: string) => propsOf(node).filter((props) => props["data-testid"] === id);

const REGISTRY = AMUX_WORKER_REGISTRY_V31_SEED.map((entry) => ({
  workerName: entry.workerName,
  providerClass: amuxWorkerProviderClassOf(entry.workerName)!,
  roleCeiling: entry.roleCeiling,
  desiredState: entry.desiredState,
  revision: 1,
}));
const RECORDED = new Map([
  ["claude-chore", {
    revision: 1,
    capability: { model: null, routingTags: ["chore"], toolCapabilities: [], v22: { model: "claude-opus-5-5", roles: ["investigate"], tools: ["repo_read"] } },
    changedAt: "2026-10-13T00:00:00.000Z",
  }],
  ["codex-impl", {
    revision: 2,
    capability: { model: null, routingTags: ["implementation"], toolCapabilities: ["shell"], v22: null },
    changedAt: "2026-10-14T00:00:00.000Z",
  }],
]);
const FAILURE = { kind: "failure", message: "failed" } as unknown as AdminApiFailure;
const VIEW = buildAmuxWorkerCapabilityAdminView({ registrations: REGISTRY, current: RECORDED, writesLatch: true });

const render = (overrides: Partial<{ view: AmuxWorkerCapabilityAdminView | null; failure: AdminApiFailure | null }> = {}) =>
  AmuxWorkerCapabilityView({
    m,
    view: "view" in overrides ? overrides.view! : VIEW,
    pending: null,
    failure: overrides.failure ?? null,
    onReread: () => {},
  });

test("each registered worker shows what is recorded, tools and v22 profile included", () => {
  const tree = render();
  assert.equal(byTestId(tree, "amux-worker-capability-panel").length, 1);
  const chore = textOf(byTestId(tree, "amux-worker-capability-row-claude-chore")[0]!.children as ReactNode);
  assert.match(chore, /tags: chore/);
  assert.match(chore, /v22: investigate \(repo_read, claude-opus-5-5\)/);
  assert.match(textOf(byTestId(tree, "amux-worker-capability-row-codex-impl")[0]!.children as ReactNode), /tools: shell/);
  assert.match(textOf(byTestId(tree, "amux-worker-capability-row-cursor-impl")[0]!.children as ReactNode), new RegExp(m.none));
  assert.equal(byTestId(tree, "amux-worker-capability-latch").length, 1);
});

test("the section offers no write: R2a's import went with the catalog variables at R2e", () => {
  const tree = render();
  const buttons = propsOf(tree).filter((props) => props.type === "button");
  assert.deepEqual(buttons, []);
  const ids = propsOf(tree).map((props) => props["data-testid"]).filter((id): id is string => typeof id === "string");
  assert.deepEqual(ids.filter((id) => /import|proposed|catalog-unreadable|status-/.test(id)), []);
  assert.match(m.description, /catalog environment variables are no longer read or imported/);
  assert.equal(["importRun", "importTitle", "catalogUnreadable", "status"].some((key) => key in m), false);
});

test("an unread view offers only reading again, and a failure is shown with its way back", () => {
  const unread = render({ view: null, failure: FAILURE });
  assert.equal(byTestId(unread, "amux-worker-capability-unavailable").length, 1);
  assert.equal(byTestId(unread, "amux-worker-capability-reread").length, 1);
  assert.equal(propsOf(unread).some((props) => props.failure === FAILURE), true);
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const rereadWith = async (answer: () => Promise<Response>) => {
  const updates: AmuxWorkerCapabilityUpdate[] = [];
  const failures: number[] = [];
  const io: AmuxWorkerCapabilityIo = {
    read: answer,
    failureOf: async (response) => {
      failures.push(response.status);
      return FAILURE;
    },
    networkFailure: () => FAILURE,
  };
  await runAmuxWorkerCapabilityReread(io, (changes) => updates.push(changes));
  const last = <K extends keyof AmuxWorkerCapabilityUpdate>(key: K) => [...updates].reverse().find((changes) => key in changes)?.[key];
  return { updates, failures, last };
};

test("reading again replaces the view with what the route answered", async () => {
  const { last, failures } = await rereadWith(() => Promise.resolve(json(200, JSON.parse(JSON.stringify(VIEW)))));
  assert.deepEqual(last("view"), VIEW);
  assert.equal(last("failure"), null);
  assert.equal(last("pending"), null);
  assert.deepEqual(failures, []);
});

test("a refused or failed read shows no capabilities and what the route answered", async () => {
  for (const status of [428, 429, 503]) {
    const { last, failures } = await rereadWith(() => Promise.resolve(json(status, { error: "x" })));
    assert.equal(last("view"), null, String(status));
    assert.equal(last("failure"), FAILURE, String(status));
    assert.deepEqual(failures, [status]);
    assert.equal(last("pending"), null);
  }
  const network = await rereadWith(() => Promise.reject(new TypeError("fetch failed")));
  assert.equal(network.last("view"), null);
  assert.equal(network.last("failure"), FAILURE);
  // A body that is not exactly the view's shape is a failed read, never a guessed list.
  const malformed = await rereadWith(() => Promise.resolve(json(200, { writesLatch: true, rows: "none" })));
  assert.equal(malformed.last("view"), null);
});
