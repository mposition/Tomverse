import assert from "node:assert/strict";
import test from "node:test";

import type { ReactNode } from "react";

import { AutoRoutedByBadge } from "@/components/chat/AutoRoutedByBadge";
import { AutoRoutingToggle } from "@/components/chat/AutoRoutingToggle";

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
  assert.match(textOf(rendered), /DeepSeek V4 Flash/);
});

test("an unknown reason identifier is dropped, never shown raw", () => {
  // `fallback_order` in somebody's chat is a leak of internal vocabulary.
  const rendered = AutoRoutedByBadge({
    routed: true,
    modelName: "DeepSeek V4 Flash",
    reason: "some_new_reason",
    language: "en",
  });

  const text = textOf(rendered);
  assert.match(text, /DeepSeek V4 Flash/);
  assert.ok(!text.includes("some_new_reason"));
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
        AutoRoutingToggle({ offered: true, enabled, language, onChange: () => {} })
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
