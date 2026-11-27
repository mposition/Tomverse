import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import ts from "typescript";

/**
 * How ChatPageClient mounts the Classic/mobile AI Review dialog.
 *
 * The dialog's own behaviour is exercised in a real browser by
 * scripts/verify-ai-review-dialog.mjs. What that harness cannot see is the
 * page's `key`: keyed on the finished-answer counter, every answer that
 * finished while a 2-of-3 review ran remounted the dialog onto its setup step.
 * The billed run still completed on the server, but its saved result was then
 * looked up by the new turn and could not be found, and a second, separately
 * billed run was one click away. So the mount is read from the syntax tree --
 * formatting-independent -- rather than from a source string.
 */

const ROOT = resolve(import.meta.dirname, "..");
const PAGE = "app/(site)/(application)/chat/ChatPageClient.tsx";

const dialogElements = async () => {
  const text = await readFile(resolve(ROOT, PAGE), "utf8");
  const file = ts.createSourceFile(PAGE, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = [];
  const visit = (node) => {
    if (
      (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
      node.tagName.getText(file) === "ComparisonReviewDialog"
    ) {
      const attributes = new Map();
      for (const property of node.attributes.properties) {
        if (!ts.isJsxAttribute(property) || !property.initializer) continue;
        const initializer = property.initializer;
        attributes.set(
          property.name.getText(file),
          ts.isJsxExpression(initializer) && initializer.expression
            ? initializer.expression
            : initializer
        );
      }
      found.push({ attributes, file });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
};

const identifiersIn = (node, file) => {
  const names = new Set();
  const visit = (child) => {
    if (ts.isIdentifier(child)) names.add(child.getText(file));
    ts.forEachChild(child, visit);
  };
  visit(node);
  return names;
};

test("the AI Review dialog is keyed by identity and conversation, never by finished answers", async () => {
  const elements = await dialogElements();
  assert.equal(elements.length, 1, "expected exactly one ComparisonReviewDialog mount");
  const [{ attributes, file }] = elements;
  const key = attributes.get("key");
  assert.ok(key, "the dialog must keep an identity/conversation key");
  const keyNames = identifiersIn(key, file);
  assert.ok(keyNames.has("identityKey"), "an identity change must still remount the dialog");
  assert.ok(keyNames.has("currentChatId"), "a conversation change must still remount the dialog");
  assert.ok(
    !keyNames.has("reviewResultRevision"),
    "a finished answer must not remount the dialog: it discards a billed run in flight"
  );
});

test("finished answers reach the dialog as a setup-only refresh signal", async () => {
  const [{ attributes, file }] = await dialogElements();
  const revision = attributes.get("sourceRevision");
  assert.ok(revision, "the dialog must still learn that answers finished");
  assert.equal(revision.getText(file), "reviewResultRevision");
});
