import assert from "node:assert/strict";
import test from "node:test";

import type { ReactNode } from "react";

import { AmuxWorkerDerivedCatalogView } from "@/components/admin/AmuxWorkerDerivedCatalogPanel";
import { adminAmuxWorkerDerivedCatalogMessages } from "@/lib/adminMessages/amuxWorkerDerivedCatalog";
import type { AmuxDerivedCatalogRow, AmuxDerivedCatalogShadowView } from "@/lib/amux/workerDerivedCatalogCore";

/**
 * AMUX › Execution › Workers, derived catalog (orchestration policy version
 * 35, R2b), executed: the hook-free view is walked for each state it can be
 * given. Read-only: nothing in it is a control.
 */

const m = adminAmuxWorkerDerivedCatalogMessages.en;
type Props = Record<string, unknown>;

const propsOf = (node: ReactNode, found: Props[] = []) => {
  if (node === null || node === undefined || typeof node === "boolean") return found;
  if (typeof node === "string" || typeof node === "number") return found;
  if (Array.isArray(node)) {
    for (const child of node) propsOf(child, found);
    return found;
  }
  const element = node as { props?: Props; type?: unknown };
  if (element.props) {
    found.push({ ...element.props, __type: element.type });
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
const render = (view: AmuxDerivedCatalogShadowView | null) => AmuxWorkerDerivedCatalogView({ m, view });

const row = (workerName: string, overrides: Partial<AmuxDerivedCatalogRow> = {}): AmuxDerivedCatalogRow => ({
  workerName,
  env: "assignable",
  derived: "present",
  verdict: "equal",
  differences: [],
  ...overrides,
});

test("with the latch off it says so and shows no comparison", () => {
  const tree = render({ shadow: "off" });
  assert.equal(textOf(byTestId(tree, "amux-worker-derived-catalog-off")[0]!.children as ReactNode), m.shadowOff);
  assert.equal(byTestId(tree, "amux-worker-derived-catalog-status").length, 0);
});

test("a failed read and an unreadable side are said as such, never as a difference", () => {
  assert.equal(byTestId(render(null), "amux-worker-derived-catalog-unavailable").length, 1);
  const derived = render({ shadow: "on", comparison: { status: "derived_unreadable", rows: [] } });
  assert.equal(textOf(byTestId(derived, "amux-worker-derived-catalog-unreadable")[0]!.children as ReactNode), m.derivedUnreadable);
  const catalog = render({ shadow: "on", comparison: { status: "catalog_unreadable", rows: [] } });
  assert.equal(textOf(byTestId(catalog, "amux-worker-derived-catalog-unreadable")[0]!.children as ReactNode), m.catalogUnreadable);
  assert.equal(byTestId(catalog, "amux-worker-derived-catalog-status").length, 0);
});

test("an equal comparison says equal, and marks the runner as a code constant", () => {
  const tree = render({ shadow: "on", comparison: { status: "equal", rows: [row("claude-impl"), row("engineering-runner")] } });
  assert.equal(textOf(byTestId(tree, "amux-worker-derived-catalog-status")[0]!.children as ReactNode), m.equal);
  assert.match(textOf(byTestId(tree, "amux-worker-derived-catalog-row-engineering-runner")[0]!.children as ReactNode), /code constant/);
  assert.doesNotMatch(textOf(byTestId(tree, "amux-worker-derived-catalog-row-claude-impl")[0]!.children as ReactNode), /code constant/);
});

test("a difference counts the rows that differ and names each field", () => {
  const tree = render({
    shadow: "on",
    comparison: {
      status: "different",
      rows: [
        row("claude-impl", { verdict: "differs", differences: ["model", "v22"] }),
        row("codex-impl", { derived: "absent", verdict: "env_only" }),
        row("claude-chore"),
      ],
    },
  });
  assert.equal(textOf(byTestId(tree, "amux-worker-derived-catalog-status")[0]!.children as ReactNode), m.different(2));
  assert.equal(textOf(byTestId(tree, "amux-worker-derived-catalog-verdict-claude-impl")[0]!.children as ReactNode), "differs: model, v22 profile");
  assert.equal(textOf(byTestId(tree, "amux-worker-derived-catalog-verdict-codex-impl")[0]!.children as ReactNode), m.verdict.env_only);
});

test("nothing in the panel is a control", () => {
  const tree = render({ shadow: "on", comparison: { status: "equal", rows: [row("claude-impl")] } });
  assert.equal(propsOf(tree).filter((props) => props.__type === "button" || typeof props.onClick === "function").length, 0);
});

test("both locales carry every message", () => {
  const keys = (value: object): string[] => Object.entries(value).flatMap(([key, entry]) =>
    entry !== null && typeof entry === "object" ? keys(entry).map((child) => `${key}.${child}`) : [key]).sort();
  assert.deepEqual(keys(adminAmuxWorkerDerivedCatalogMessages.ko), keys(adminAmuxWorkerDerivedCatalogMessages.en));
});
