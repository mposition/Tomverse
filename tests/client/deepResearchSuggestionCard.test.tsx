import assert from "node:assert/strict";
import test from "node:test";

import type { ReactNode } from "react";

import { DeepResearchSuggestionCard } from "@/components/chat/DeepResearchSuggestionCard";
import { resolveDeepResearchSuggestionCopy } from "@/components/chat/deepResearchSuggestionCopy";
import { ko } from "@/locales/ko";

/**
 * What the expansion offer renders, executed.
 *
 * Same technique as `autoRoutingRender.test.tsx`: the unit runner cannot load
 * `react-dom/server`, so the component is called and the returned element tree
 * is walked. That reads props the markup would only have flattened, which is
 * exactly what the accessibility claims are made of.
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

const byTestId = (node: ReactNode, testId: string) =>
  propsOf(node).find((props) => props["data-testid"] === testId);

const textOf = (node: ReactNode): string => {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  const element = node as { props?: { children?: ReactNode } };
  return element.props ? textOf(element.props.children) : "";
};

const translate = (key: string) => {
  const value = key
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === "object"
          ? (node as Record<string, unknown>)[part]
          : undefined,
      ko
    );
  assert.equal(typeof value, "string", `missing key ${key}`);
  return value as string;
};

const copy = resolveDeepResearchSuggestionCopy({
  t: translate,
  estimatedCredits: 21,
});

const render = (overrides: Partial<Parameters<typeof DeepResearchSuggestionCard>[0]> = {}) =>
  DeepResearchSuggestionCard({
    copy,
    isStarting: false,
    onExpand: () => {},
    onDismiss: () => {},
    ...overrides,
  });

test("the card is a named region, never an alert", () => {
  const card = byTestId(render(), "deep-research-suggestion");
  assert.ok(card);
  assert.equal(card.role, "region");
  // An alert interrupts whatever a screen reader is reading. The answer this
  // sits under is finished and correct; nothing here is urgent.
  assert.notEqual(card.role, "alert");
  assert.equal(typeof card["aria-labelledby"], "string");
});

test("requirement 11: both actions have their own name and a description", () => {
  const tree = render();
  const expand = byTestId(tree, "deep-research-suggestion-expand");
  const dismiss = byTestId(tree, "deep-research-suggestion-dismiss");
  assert.ok(expand);
  assert.ok(dismiss);

  // Real buttons: keyboard activation and focus order come free, and neither
  // is a div with a click handler.
  assert.equal(expand.type, "button");
  assert.equal(dismiss.type, "button");

  assert.equal(textOf(expand.children as ReactNode), ko.chat.deepResearchSuggestionExpand);
  assert.equal(textOf(dismiss.children as ReactNode), ko.chat.deepResearchSuggestionDismiss);

  const card = byTestId(tree, "deep-research-suggestion");
  const description = propsOf(tree).find(
    (props) => props.id === expand["aria-describedby"]
  );
  assert.ok(description, "the expand action describes itself");
  assert.equal(dismiss["aria-describedby"], expand["aria-describedby"]);
  assert.notEqual(card!["aria-labelledby"], expand["aria-describedby"]);
});

test("requirement 11: the estimate is part of what the actions point at", () => {
  const tree = render();
  const expand = byTestId(tree, "deep-research-suggestion-expand")!;
  const estimate = byTestId(tree, "deep-research-suggestion-estimate");
  assert.ok(estimate, "the estimate line is rendered");
  // The described-by target and the estimate live in the same text column, so
  // a reader who lands on the button alone still hears the cost.
  const describedBy = propsOf(tree).find(
    (props) => props.id === expand["aria-describedby"]
  );
  assert.ok(describedBy);
  assert.ok(copy.estimate!.includes(ko.chat.deepResearchEstimatedTimeValue));
  assert.equal(textOf(estimate.children as ReactNode), copy.estimate);
});

test("no estimate line at all when there is no figure to show", () => {
  const tree = render({
    copy: { ...copy, estimate: null },
  });
  assert.equal(byTestId(tree, "deep-research-suggestion-estimate"), undefined);
});

test("running disables both actions and says so in the accessibility tree", () => {
  const tree = render({ isStarting: true });
  const card = byTestId(tree, "deep-research-suggestion")!;
  assert.equal(card["aria-busy"], true);
  assert.equal(card["data-starting"], "true");

  for (const testId of [
    "deep-research-suggestion-expand",
    "deep-research-suggestion-dismiss",
  ]) {
    const action = byTestId(tree, testId)!;
    assert.equal(action.disabled, true, testId);
    assert.equal(action["aria-disabled"], true, testId);
  }

  const status = byTestId(tree, "deep-research-suggestion-status")!;
  assert.equal(status["aria-live"], "polite");
  assert.equal(textOf(status.children as ReactNode), ko.chat.deepResearchSuggestionStarting);
});

test("the status line is silent while the card is merely on offer", () => {
  const status = byTestId(render(), "deep-research-suggestion-status")!;
  assert.equal(textOf(status.children as ReactNode), "");
});

test("nothing in the card moves focus or captures the page", () => {
  for (const props of propsOf(render())) {
    assert.equal(props.autoFocus, undefined);
    // A dialog would trap focus and demand a dismissal before the next
    // question could be typed. This offer never blocks the flow.
    assert.notEqual(props.role, "dialog");
    assert.equal(props["aria-modal"], undefined);
  }
});

test("the card carries only Deep Research's own accent role", () => {
  const classes = propsOf(render())
    .map((props) => (typeof props.className === "string" ? props.className : ""))
    .join(" ");
  assert.ok(classes.includes("accent-deep-research-"));
  for (const reserved of [
    "accent-ai-review-",
    "accent-image-",
    "accent-generated-artifact-",
  ]) {
    assert.ok(!classes.includes(reserved), reserved);
  }
});

test("the actions run exactly the handler they are given, once per press", () => {
  let expanded = 0;
  let dismissed = 0;
  const tree = render({
    onExpand: () => {
      expanded += 1;
    },
    onDismiss: () => {
      dismissed += 1;
    },
  });
  (byTestId(tree, "deep-research-suggestion-expand")!.onClick as () => void)();
  assert.equal(expanded, 1);
  assert.equal(dismissed, 0);
  (byTestId(tree, "deep-research-suggestion-dismiss")!.onClick as () => void)();
  assert.equal(dismissed, 1);
  assert.equal(expanded, 1);
});
