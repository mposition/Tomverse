import assert from "node:assert/strict";
import test from "node:test";

import type { ReactNode } from "react";

import { MarketingWebhookStaging } from "@/components/admin/AdminMarketingPanel";
import type { MarketingAction } from "@/components/admin/MarketingActions";
import { adminMarketingMessages } from "@/lib/adminMessages/marketing";

/**
 * The staging webhook block (S2e), executed.
 *
 * Same technique as the other client render tests: the component is called and
 * the returned element tree walked, so the actions each rail is handed -- path,
 * method and the exact body the write will compare against -- are read
 * directly rather than through markup.
 */

const m = adminMarketingMessages.en as unknown as Record<string, string>;

const propsOf = (node: ReactNode, found: Record<string, unknown>[] = []) => {
  if (node === null || node === undefined || typeof node === "boolean") return found;
  if (typeof node === "string" || typeof node === "number") return found;
  if (Array.isArray(node)) {
    for (const child of node) propsOf(child, found);
    return found;
  }
  const element = node as { props?: Record<string, unknown> };
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

const actionsOf = (node: ReactNode) =>
  propsOf(node).flatMap((props) =>
    Array.isArray(props.actions) ? (props.actions as MarketingAction[]) : [],
  );

const DIGEST = "d".repeat(64);
const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const past = new Date(Date.now() - 60 * 1000).toISOString();

const staging = (overrides: Record<string, unknown> = {}) => ({
  readable: true,
  faultArm: null,
  faultArmUnreadable: false,
  faultArmExpired: false,
  shadowReports: [
    {
      id: "rep-1",
      createdAt: "2026-10-02T09:00:00.000Z",
      eventIdDigest: DIGEST,
      eventType: "post.published",
      channel: "linkedin",
      accountSlug: "linkedin-1",
      derivedStatus: "published",
      statusQueryMatch: true,
    },
  ],
  ...overrides,
});

const render = (props: {
  staging?: Record<string, unknown>;
  shadow?: "on" | "off" | "unreadable";
  canWrite?: boolean;
}) =>
  MarketingWebhookStaging({
    staging: staging(props.staging) as never,
    shadow: props.shadow ?? "off",
    canWrite: props.canWrite ?? true,
    section: "reports",
    onDone: () => undefined,
    m,
  });

test("the shadow toggle sends the opposite of what the screen read, by PATCH", () => {
  const off = actionsOf(render({ shadow: "off" })).find((a) => a.id === "webhook-shadow-toggle");
  assert.equal(off?.method, "PATCH");
  assert.equal(off?.path, "/api/admin/marketing/webhook/shadow");
  assert.deepEqual(off?.body({}), { enabled: true, expectedEnabled: false });
  assert.ok(off?.confirm, "turning it on is confirmed first");

  const on = actionsOf(render({ shadow: "on" })).find((a) => a.id === "webhook-shadow-toggle");
  assert.deepEqual(on?.body({}), { enabled: false, expectedEnabled: true });

  // A state that was not read is not toggled.
  assert.equal(
    actionsOf(render({ shadow: "unreadable" })).some((a) => a.id === "webhook-shadow-toggle"),
    false,
  );
});

test("each report arms its own event, against the generation shown", () => {
  const armed = render({
    staging: {
      faultArm: {
        eventIdDigest: "e".repeat(64),
        state: "consumed",
        generation: 4,
        armedAt: past,
        expiresAt: future,
      },
    },
  });
  const action = actionsOf(armed).find((a) => a.id === "webhook-fault-arm-rep-1");
  assert.equal(action?.path, "/api/admin/marketing/webhook/fault-arm");
  assert.deepEqual(action?.body({ ttlMinutes: "45" }), {
    eventIdDigest: DIGEST,
    expectedGeneration: 4,
    ttlMinutes: 45,
  });
  // Nothing armed yet: generation 0.
  const fresh = actionsOf(render({})).find((a) => a.id === "webhook-fault-arm-rep-1");
  assert.equal((fresh?.body({ ttlMinutes: "30" }) as { expectedGeneration: number }).expectedGeneration, 0);
});

test("a reader, a foreign arm value or an unreadable state offers no write", () => {
  for (const [label, props] of [
    ["reader", { canWrite: false }],
    ["foreign arm", { staging: { faultArmUnreadable: true } }],
    ["unreadable", { staging: { readable: false } }],
  ] as const) {
    const actions = actionsOf(render(props as never));
    assert.equal(
      actions.some((a) => a.id.startsWith("webhook-fault-arm-")),
      false,
      label,
    );
  }
  assert.equal(actionsOf(render({ canWrite: false })).length, 0);
});

test("the arm line says what is true: none, armed, consumed, expired or foreign", () => {
  const line = (props: Parameters<typeof render>[0]) => textOf(render(props));
  assert.ok(line({}).includes(m.webhookArmNone));
  assert.ok(
    line({
      staging: {
        faultArm: { eventIdDigest: DIGEST, state: "armed", generation: 2, armedAt: past, expiresAt: future },
      },
    }).includes("generation 2"),
  );
  assert.ok(
    line({
      staging: {
        faultArm: { eventIdDigest: DIGEST, state: "armed", generation: 3, armedAt: past, expiresAt: past },
        faultArmExpired: true,
      },
    }).includes(m.webhookArmExpired.replace("{generation}", "3")),
  );
  assert.ok(
    line({
      staging: {
        faultArm: { eventIdDigest: DIGEST, state: "consumed", generation: 5, armedAt: past, expiresAt: future },
      },
    }).includes(m.webhookArmConsumed.replace("{generation}", "5")),
  );
  assert.ok(line({ staging: { faultArmUnreadable: true } }).includes(m.webhookArmForeign));
  assert.ok(line({ staging: { readable: false } }).includes(m.webhookUnreadable));
});

test("the list states how many it shows, and an empty one says so", () => {
  assert.ok(textOf(render({})).includes(m.webhookReportsTitle.replace("{count}", "1")));
  assert.ok(textOf(render({ staging: { shadowReports: [] } })).includes(m.webhookReportsEmpty));
});
