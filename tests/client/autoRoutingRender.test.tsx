import assert from "node:assert/strict";
import test from "node:test";

import type { ReactNode } from "react";

import { AutoRoutedByBadge } from "@/components/chat/AutoRoutedByBadge";
import {
  AutoRoutingComposerToggle,
  AutoRoutingToggle,
} from "@/components/chat/AutoRoutingToggle";
import {
  ChatInputAutoCapabilityPendingNotice,
  ChatInputWebSearchChipView,
  ChatInputWebSearchSwitchDescription,
} from "@/components/chat/ChatInput";
import type { WebSearchComposerState } from "@/lib/webSearchComposerState";

/**
 * UI contract auto-model-selection.md §1, and the evidence the wiring change
 * owes.
 *
 * The contract has existed since before either component was mounted, which
 * means until now it had never actually been executed: a rule about what a
 * component renders is a claim about a component nothing renders. This is what
 * turns it into a fact.
 *
 * ## Why the components are called rather than rendered
 *
 * The unit runner passes `--conditions=react-server`, under which
 * `react-dom/server` refuses to load at all -- correctly, since it is not
 * supported in React Server Components. Reaching past that into React's `cjs/`
 * internals would buy a string of HTML at the price of a test that breaks on a
 * React patch release.
 *
 * These are plain function components, so calling one *is* rendering it for
 * the purpose of this contract: "renders nothing" is `null`, and there is no
 * way for a component that returns `null` to leave a wrapper, a margin or a
 * row height behind. For the positive cases the returned element tree is
 * walked, which reads props the markup would only have flattened.
 */

/** Every string in a returned element tree, in order. */
const textOf = (node: ReactNode): string => {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  const element = node as { props?: { children?: ReactNode } };
  return element.props ? textOf(element.props.children) : "";
};

/** Every prop object in a returned element tree. */
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

const findProp = (node: ReactNode, key: string) =>
  propsOf(node).find((props) => props[key] !== undefined)?.[key];

/* ------------------------------------------------------------- the toggle */

test("the toggle renders nothing at all when Auto is not offered", () => {
  const rendered = AutoRoutingToggle({
    offered: false,
    enabled: false,
    language: "en",
    onChange: () => {},
  });

  assert.equal(rendered, null);
});

test("offered:false renders nothing even when the conversation is stored as auto", () => {
  // The state an account that has left the cohort is in. A control here would
  // offer to change something the server would refuse.
  const rendered = AutoRoutingToggle({
    offered: false,
    enabled: true,
    language: "ko",
    onChange: () => {},
  });

  assert.equal(rendered, null);
});

test("the toggle renders a real switch when Auto is offered", () => {
  // The other half: a test that only proved absence would pass on a component
  // that rendered nothing ever.
  const rendered = AutoRoutingToggle({
    offered: true,
    enabled: false,
    language: "en",
    onChange: () => {},
  });

  assert.notEqual(rendered, null);
  assert.equal(findProp(rendered, "data-testid"), "auto-routing-toggle");
  assert.equal(findProp(rendered, "role"), "switch");
  assert.equal(findProp(rendered, "aria-checked"), false);
});

test("the switch reports its state in aria-checked, not in colour alone", () => {
  const rendered = AutoRoutingToggle({
    offered: true,
    enabled: true,
    language: "en",
    onChange: () => {},
  });

  assert.equal(findProp(rendered, "aria-checked"), true);
});

test("pending guards a double-send; it is not the greyed row the contract forbids", () => {
  // The forbidden state is a control shown to an account that can never use
  // it. This one is shown to an account that can, while its own change is in
  // flight.
  const rendered = AutoRoutingToggle({
    offered: true,
    enabled: false,
    pending: true,
    language: "en",
    onChange: () => {},
  });

  assert.equal(findProp(rendered, "data-testid"), "auto-routing-toggle");
  assert.equal(findProp(rendered, "disabled"), true);
});

test("the switch carries an accessible name at every width", () => {
  const rendered = AutoRoutingToggle({
    offered: true,
    enabled: false,
    language: "ko",
    onChange: () => {},
  });

  const label = findProp(rendered, "aria-label");
  assert.equal(typeof label, "string");
  assert.ok((label as string).length > 0);
});

test("the composer Auto switch obeys the same offered boundary", () => {
  assert.equal(
    AutoRoutingComposerToggle({
      offered: false,
      enabled: false,
      language: "en",
      onChange: () => {},
    }),
    null
  );

  const rendered = AutoRoutingComposerToggle({
    offered: true,
    enabled: true,
    language: "ko",
    onChange: () => {},
  });

  assert.equal(findProp(rendered, "data-testid"), "composer-auto-routing-toggle");
  assert.equal(findProp(rendered, "role"), "switch");
  assert.equal(findProp(rendered, "aria-checked"), true);
  assert.match(textOf(rendered), /자동/);
});

test("the pending composer switch cannot issue a second mode change", () => {
  const rendered = AutoRoutingComposerToggle({
    offered: true,
    enabled: false,
    pending: true,
    language: "en",
    onChange: () => {},
  });

  assert.equal(findProp(rendered, "disabled"), true);
});

test("Guest Auto capability preparation is announced without claiming a variable-cost send is ready", () => {
  const rendered = ChatInputAutoCapabilityPendingNotice({
    visible: true,
    label: "Smart Adaptive · Loading",
  });

  assert.equal(findProp(rendered, "data-testid"), "guest-auto-capability-pending");
  assert.equal(findProp(rendered, "role"), "status");
  assert.equal(findProp(rendered, "aria-live"), "polite");
  assert.match(textOf(rendered), /Smart Adaptive · Loading/);
});

test("Guest Auto capability preparation leaves no stale status after confirmation", () => {
  assert.equal(
    ChatInputAutoCapabilityPendingNotice({
      visible: false,
      label: "Smart Adaptive · Loading",
    }),
    null
  );
});

/* --------------------------------------- Auto-aware web search presentation */

const webSearchState = (
  overrides: Partial<WebSearchComposerState> = {}
): WebSearchComposerState => ({
  mode: "always",
  isVisible: true,
  selectedCount: 1,
  supportedCount: 0,
  unsupportedCount: 1,
  unsupportedModelIds: ["manual-fallback"],
  allUnsupported: true,
  tone: "blocked",
  hasException: true,
  estimatedSurchargeCredits: 8,
  ...overrides,
});

const webSearchChip = (
  isAutoMode: boolean,
  state: WebSearchComposerState = webSearchState()
) =>
  ChatInputWebSearchChipView({
    state,
    isAutoMode,
    isMobileShell: false,
    fullLabel: isAutoMode ? "Web search on" : "Web search · 1/2 supported",
    compactLabel: isAutoMode ? "Web search" : "Web search 1/2",
    description: isAutoMode
      ? "Searches the web automatically when current information or sources are needed."
      : "1 of 2 selected models can search. Up to 8 extra credits are reserved.",
    removeLabel: "Turn web search off",
    isExceptionOpen: false,
    onToggleException: () => {},
    onRemove: () => {},
  });

test("Auto web search does not present the manual fallback as the answering model", () => {
  const rendered = webSearchChip(true);
  const chip = propsOf(rendered).find(
    (props) => props["data-testid"] === "web-search-mode-chip"
  );
  assert.ok(chip);
  assert.equal(chip["data-selection-mode"], "auto");
  assert.equal(chip["data-tone"], "neutral");
  assert.equal(chip["data-supported-count"], undefined);
  assert.equal(chip["data-unsupported-count"], undefined);
  assert.equal(
    propsOf(rendered).some(
      (props) => props["data-testid"] === "web-search-exception-toggle"
    ),
    false
  );

  const text = textOf(rendered);
  assert.match(text, /current information or sources are needed/);
  assert.doesNotMatch(text, /selected models|8 extra credits|manual-fallback/);
});

test("manual web search keeps exact support counts and its exception control", () => {
  const rendered = webSearchChip(
    false,
    webSearchState({
      selectedCount: 2,
      supportedCount: 1,
      unsupportedCount: 1,
      allUnsupported: false,
      tone: "warning",
    })
  );
  const chip = propsOf(rendered).find(
    (props) => props["data-testid"] === "web-search-mode-chip"
  );
  assert.ok(chip);
  assert.equal(chip["data-selection-mode"], "manual");
  assert.equal(chip["data-tone"], "warning");
  assert.equal(chip["data-supported-count"], 1);
  assert.equal(chip["data-unsupported-count"], 1);
  assert.equal(
    propsOf(rendered).some(
      (props) => props["data-testid"] === "web-search-exception-toggle"
    ),
    true
  );
  assert.match(textOf(rendered), /1 of 2 selected models can search/);
  assert.match(textOf(rendered), /8 extra credits/);
});

test("Auto web search switch renders only the general conditional-search explanation", () => {
  const auto = ChatInputWebSearchSwitchDescription({
    isAutoMode: true,
    isWebSearchOn: true,
    description:
      "Searches the web automatically when current information or sources are needed.",
    costNote: "An extra 8 credits apply per selected model.",
  });
  assert.match(textOf(auto), /when current information or sources are needed/);
  assert.doesNotMatch(textOf(auto), /8 credits|selected model/);

  const manual = ChatInputWebSearchSwitchDescription({
    isAutoMode: false,
    isWebSearchOn: true,
    description:
      "Searches the web automatically when current information or sources are needed.",
    costNote: "An extra 8 credits apply per selected model.",
  });
  assert.match(textOf(manual), /8 credits apply per selected model/);
});

/* -------------------------------------------------------------- the badge */

test("the badge renders nothing on a turn Auto did not route", () => {
  assert.equal(
    AutoRoutedByBadge({
      routed: false,
      modelName: "DeepSeek V4 Flash",
      reason: "quality_band",
      language: "en",
    }),
    null
  );
});

test("the badge renders nothing without a model name to show", () => {
  assert.equal(
    AutoRoutedByBadge({
      routed: true,
      modelName: "",
      reason: "quality_band",
      language: "en",
    }),
    null
  );
});

test("the badge names the model that answered", () => {
  const rendered = AutoRoutedByBadge({
    routed: true,
    modelName: "DeepSeek V4 Flash",
    reason: "quality_band",
    language: "en",
  });

  assert.equal(findProp(rendered, "data-testid"), "auto-routed-by");
  assert.equal(
    textOf(rendered).replace(/\s+/g, " ").trim(),
    "Auto · DeepSeek V4 Flash"
  );
});

test("selection reasons do not change the neutral answering-model badge", () => {
  for (const reason of [
    "only_candidate",
    "task_preference",
    "fallback_order",
    "sticky",
    "some_new_reason",
    null,
  ]) {
    const rendered = AutoRoutedByBadge({
      routed: true,
      modelName: "Qwen 3.8 Flash",
      reason,
      language: "ko",
    });

    assert.equal(
      textOf(rendered).replace(/\s+/g, " ").trim(),
      "자동 · Qwen 3.8 Flash"
    );
    // The full phrase moves to the hover title, never into the reason.
    assert.equal(findProp(rendered, "title"), "자동 선택 · Qwen 3.8 Flash");
  }
});

/* ------------------------------------------------- what the copy may say */

const LANGUAGES = ["en", "ko", "zh", "fr", "de", "es", "pt"] as const;

const FORBIDDEN_SUPERIORITY = [
  "better",
  "best",
  "optimal",
  "smartest",
  "가장 좋은",
  "최적",
  "最好",
  "最佳",
  "meilleur",
  "beste",
  "mejor",
  "melhor",
];

test("no rendered Auto copy promises a better or optimal model", () => {
  // ROUTE-01 measures non-inferiority, which is a far weaker claim than that
  // copy would be making. Asserted on what the components actually render, so
  // a string introduced anywhere in them is caught -- not only one added to
  // the copy table.
  for (const language of LANGUAGES) {
    for (const enabled of [true, false]) {
      const text = textOf(
        <>
          {AutoRoutingToggle({ offered: true, enabled, language, onChange: () => {} })}
          {AutoRoutingComposerToggle({
            offered: true,
            enabled,
            language,
            onChange: () => {},
          })}
        </>
      ).toLowerCase();

      for (const word of FORBIDDEN_SUPERIORITY) {
        assert.ok(
          !text.includes(word.toLowerCase()),
          `${language} toggle (enabled=${enabled}) must not promise "${word}"`
        );
      }
    }
  }
});

test("no rendered Auto copy names a bucket, share, salt, flag or gate", () => {
  // UI contract §2: a client that could read its own bucket could work out the
  // rollout percentage, and one that knew the salt could work out anyone's.
  const forbidden = [
    "bucket",
    "cohort",
    "rollout",
    "salt",
    "readiness",
    "percent",
    "flag",
    "%",
  ];

  for (const language of LANGUAGES) {
    const surfaces = [
      textOf(
        AutoRoutingToggle({
          offered: true,
          enabled: true,
          language,
          onChange: () => {},
        })
      ),
      textOf(
        AutoRoutingComposerToggle({
          offered: true,
          enabled: true,
          language,
          onChange: () => {},
        })
      ),
      textOf(
        AutoRoutedByBadge({
          routed: true,
          modelName: "DeepSeek V4 Flash",
          reason: "quality_band",
          language,
        })
      ),
    ];

    for (const text of surfaces) {
      for (const word of forbidden) {
        assert.ok(
          !text.toLowerCase().includes(word),
          `${language}: rendered Auto copy must not name "${word}"`
        );
      }
    }
  }
});

test("the badge never names the Prompt Refiner or any provider but the answering model", () => {
  // v1.2 removed Refiner disclosure from this document deliberately: the
  // Refiner is not the model that answered, and exposing an internal
  // prompt-processing model is a separate UX and security decision.
  for (const language of LANGUAGES) {
    const text = textOf(
      AutoRoutedByBadge({
        routed: true,
        modelName: "DeepSeek V4 Flash",
        reason: "quality_band",
        language,
      })
    ).toLowerCase();

    for (const word of ["refiner", "planner", "리파이너", "프롬프트 개선"]) {
      assert.ok(!text.includes(word), `${language} badge must not name "${word}"`);
    }
  }
});
