import assert from "node:assert/strict";
import test from "node:test";

import type { ReactNode } from "react";

import { WebSearchSuggestionCard } from "@/components/chat/WebSearchSuggestionCard";
import { resolveWebSearchSuggestionCopy } from "@/components/chat/webSearchSuggestionCopy";
import type { WebSearchSuggestionState } from "@/lib/webSearchRetrySuggestion";
import { ko } from "@/locales/ko";

/**
 * What the web-search offer renders, executed.
 *
 * Same technique as `deepResearchSuggestionCard.test.tsx`: the unit runner
 * cannot load `react-dom/server`, so the component is called and the returned
 * element tree is walked. That reads props the markup would only have
 * flattened, which is exactly what the accessibility claims are made of.
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

const copyFor = (state: WebSearchSuggestionState) =>
  resolveWebSearchSuggestionCopy({ t: translate, state, surchargeCredits: 8 });

const render = (
  state: WebSearchSuggestionState = "enable",
  overrides: Partial<Parameters<typeof WebSearchSuggestionCard>[0]> = {}
) =>
  WebSearchSuggestionCard({
    copy: copyFor(state),
    state,
    isStarting: false,
    onConfirm: () => {},
    onDismiss: () => {},
    ...overrides,
  });

test("the card is a named region, never an alert", () => {
  const card = byTestId(render(), "web-search-suggestion");
  assert.ok(card);
  assert.equal(card.role, "region");
  // An alert interrupts whatever a screen reader is reading. Nothing here is
  // urgent, and the states that say "this cannot be done" are the least
  // urgent of all -- they are not the user's mistake.
  assert.notEqual(card.role, "alert");
  assert.equal(typeof card["aria-labelledby"], "string");
});

test("the offered state renders both actions as real buttons with their own names", () => {
  const tree = render("enable");
  const confirm = byTestId(tree, "web-search-suggestion-confirm");
  const dismiss = byTestId(tree, "web-search-suggestion-dismiss");
  assert.ok(confirm);
  assert.ok(dismiss);

  // Real buttons: keyboard activation and focus order come free, and neither
  // is a div with a click handler.
  assert.equal(confirm.type, "button");
  assert.equal(dismiss.type, "button");

  assert.equal(
    textOf(confirm.children as ReactNode),
    ko.chat.webSearchSuggestionConfirm
  );
  assert.equal(
    textOf(dismiss.children as ReactNode),
    ko.chat.webSearchSuggestionDismiss
  );

  const card = byTestId(tree, "web-search-suggestion")!;
  const description = propsOf(tree).find(
    (props) => props.id === confirm["aria-describedby"]
  );
  assert.ok(description, "the confirm action describes itself");
  assert.equal(dismiss["aria-describedby"], confirm["aria-describedby"]);
  assert.notEqual(card["aria-labelledby"], confirm["aria-describedby"]);
});

test("the primary action names the result, not the setting", () => {
  // "Check the web" over "Turn on web search": the offer is about the answer
  // the user wanted, and a settings verb makes it their configuration problem.
  assert.equal(ko.chat.webSearchSuggestionConfirm, "웹에서 확인");
  assert.equal(ko.chat.webSearchSuggestionDismiss, "지금은 안 함");
});

test("the estimate is part of what the actions point at", () => {
  const tree = render("enable");
  const confirm = byTestId(tree, "web-search-suggestion-confirm")!;
  const estimate = byTestId(tree, "web-search-suggestion-estimate");
  assert.ok(estimate, "the estimate line is rendered");
  const describedBy = propsOf(tree).find(
    (props) => props.id === confirm["aria-describedby"]
  );
  assert.ok(describedBy);
  assert.equal(textOf(estimate.children as ReactNode), copyFor("enable").estimate);
});

test("no estimate line at all when there is no figure to show", () => {
  const tree = render("enable", {
    copy: { ...copyFor("enable"), estimate: null },
  });
  assert.equal(byTestId(tree, "web-search-suggestion-estimate"), undefined);
});

test("a state with nothing to press renders no primary button, not a dead one", () => {
  for (const state of ["unsupported", "blocked"] as const) {
    const tree = render(state);
    assert.equal(
      byTestId(tree, "web-search-suggestion-confirm"),
      undefined,
      `${state} must not render a search action`
    );
    // Still dismissible, and still says which state it is.
    assert.ok(byTestId(tree, "web-search-suggestion-dismiss"), state);
    assert.equal(byTestId(tree, "web-search-suggestion")!["data-state"], state);
  }
});

test("a failed run offers a retry", () => {
  const tree = render("error");
  const confirm = byTestId(tree, "web-search-suggestion-confirm");
  assert.ok(confirm);
  assert.equal(
    textOf(confirm.children as ReactNode),
    ko.chat.webSearchSuggestionRetry
  );
});

test("running disables both actions and says so in the accessibility tree", () => {
  const tree = render("enable", { isStarting: true });
  const card = byTestId(tree, "web-search-suggestion")!;
  const confirm = byTestId(tree, "web-search-suggestion-confirm")!;
  const dismiss = byTestId(tree, "web-search-suggestion-dismiss")!;

  assert.equal(card["aria-busy"], true);
  assert.equal(confirm.disabled, true);
  assert.equal(dismiss.disabled, true);
  // `disabled` alone is enough for the browser; `aria-disabled` is what a
  // reader announces, and both are set so the two agree.
  assert.equal(confirm["aria-disabled"], true);
  assert.equal(dismiss["aria-disabled"], true);
});

test("the loading state is announced politely and is empty until there is one", () => {
  const idle = byTestId(render("enable"), "web-search-suggestion-status")!;
  assert.equal(idle.role, "status");
  assert.equal(idle["aria-live"], "polite");
  assert.equal(textOf(idle.children as ReactNode), "");

  const running = byTestId(
    render("enable", { isStarting: true }),
    "web-search-suggestion-status"
  )!;
  assert.equal(
    textOf(running.children as ReactNode),
    ko.chat.webSearchSuggestionStarting
  );
});

test("the card never moves focus", () => {
  // No autoFocus anywhere: someone part way through typing their next question
  // must not lose the caret to a card that appeared under them.
  for (const props of propsOf(render("enable"))) {
    assert.notEqual(props.autoFocus, true);
  }
});

test("the icon is decorative and the text carries the meaning", () => {
  const tree = render("enable");
  const hidden = propsOf(tree).filter((props) => props["aria-hidden"] === "true");
  assert.ok(hidden.length > 0, "the icon is hidden from the accessibility tree");
});
