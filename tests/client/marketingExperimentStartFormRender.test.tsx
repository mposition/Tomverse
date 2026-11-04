import assert from "node:assert/strict";
import test from "node:test";

import type { ReactNode } from "react";

import { MarketingExperimentTop } from "@/components/admin/AdminMarketingPanel";
import type { MarketingAction } from "@/components/admin/MarketingActions";
import { adminMarketingMessages } from "@/lib/adminMessages/marketing";

/**
 * The experiment start form, executed: the bundle select has no default (an
 * operator once started the example bundle by leaving it alone), and the
 * confirmation and the result name the bundle and variant.
 */

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

const actionsOf = (node: ReactNode) =>
  propsOf(node).flatMap((props) =>
    Array.isArray(props.actions) ? (props.actions as MarketingAction[]) : []
  );

const BUNDLES = [{ bundleId: "home-hero-v2", variantId: "b", locales: ["en", "ko"] }];

const startAction = (language: "en" | "ko" = "en") => {
  const m = adminMarketingMessages[language] as unknown as Record<string, string>;
  const tree = MarketingExperimentTop({
    view: { canWrite: true, section: "experiments", switches: { experiments: "on" } } as never,
    experiments: {
      version: null,
      unreadable: false,
      spikePassed: true,
      bundles: BUNDLES,
      hasRunning: false,
    },
    onDone: () => undefined,
    m,
  });
  const action = actionsOf(tree).find((candidate) => candidate.id === "experiment-start");
  assert.ok(action, "the start action is drawn");
  return { action, m };
};

test("the bundle select starts empty and must be picked", () => {
  const { action } = startAction();
  const field = action.fields?.find((candidate) => candidate.name === "bundle");
  assert.ok(field);
  assert.equal(field.initial, undefined, "no default pick");
  assert.equal(field.required, true);
  assert.deepEqual(field.options, ["home-hero-v2 / b"]);
});

test("the confirmation and the result name the bundle and the variant", () => {
  for (const language of ["en", "ko"] as const) {
    const { action, m } = startAction(language);
    assert.equal(typeof action.confirm, "function");
    const question = (action.confirm as (values: Record<string, string>) => string)({
      bundle: "home-hero-v2 / b",
      locales: "en",
      share: "10",
      days: "14",
    });
    assert.match(question, /home-hero-v2 \/ b/);
    assert.doesNotMatch(question, /\{[a-z]+\}/, "every placeholder is filled");
    const done = action.describe?.({
      experimentId: "hero-2",
      bundleId: "home-hero-v2",
      variantId: "b",
    });
    assert.ok(done);
    assert.match(done, /hero-2/);
    assert.match(done, /home-hero-v2 \/ b/);
    assert.doesNotMatch(done, /\{[a-z]+\}/);
    assert.ok(m.confirmStartExperiment && m.expStartedDone);
  }
});

test("the rail refuses to submit while a required field is empty", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync("components/admin/MarketingActions.tsx", "utf8");
  const submit = source.slice(source.indexOf("onSubmit={(event) => {"));
  const requiredAt = submit.indexOf("field.required");
  const sendAt = submit.indexOf("send(opened");
  assert.ok(requiredAt > 0 && sendAt > requiredAt, "required is checked before the send");
  assert.match(source, /<select\s+required=\{field\.required\}/);
});
