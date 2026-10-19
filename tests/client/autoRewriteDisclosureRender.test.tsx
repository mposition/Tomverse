import assert from "node:assert/strict";
import test from "node:test";

import type { ReactNode } from "react";

import { AutoRewriteDisclosure } from "@/components/chat/AutoRewriteDisclosure";
import { autoRoutingCopy, type AutoRoutingLanguage } from "@/lib/autoRoutingCopy";

// docs/ui-contracts/prompt-refiner-suggestion.md §9: the reply shows how Auto
// read the message, collapsed, and says the user's own message is unchanged.
// Called rather than rendered, as tests/client/autoRoutingRender.test.tsx
// explains.

const textOf = (node: ReactNode): string => {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  const element = node as { props?: { children?: ReactNode } };
  return element.props ? textOf(element.props.children) : "";
};

test("the disclosure is collapsed and carries the rewrite and the unchanged-message note", () => {
  const rewrite = "Fix the Python CSV parser above so it skips non-numeric columns.";
  const node = AutoRewriteDisclosure({ rewrite, language: "ko" }) as unknown as {
    type: string;
    props: { open?: boolean; "data-testid"?: string };
  };
  assert.equal(node.type, "details");
  assert.equal(node.props.open, undefined);
  assert.equal(node.props["data-testid"], "auto-rewrite");
  const text = textOf(node as unknown as ReactNode);
  assert.ok(text.includes(rewrite));
  assert.ok(text.includes(autoRoutingCopy.ko.rewriteSummary));
  assert.ok(text.includes(autoRoutingCopy.ko.rewriteNote));
});

test("every language has the disclosure copy", () => {
  for (const language of Object.keys(autoRoutingCopy) as AutoRoutingLanguage[]) {
    assert.ok(autoRoutingCopy[language].rewriteSummary.trim(), language);
    assert.ok(autoRoutingCopy[language].rewriteNote.trim(), language);
  }
});
