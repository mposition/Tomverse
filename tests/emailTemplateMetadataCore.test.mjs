import assert from "node:assert/strict";
import { test } from "node:test";

import {
  templateMetadataMismatches,
  templateSendMetadata,
} from "../lib/emailTemplateMetadataCore.ts";
import { EMAIL_TEMPLATE_KEYS, emailTemplateDefinition } from "../lib/emailTemplateDefinitions.ts";

// Contract: docs/policy/email-notifications.md §10.2.

const transactional = {
  classification: "transactional",
  purpose: null,
  requiresUnsubscribe: false,
};

test("a version that matches its definition has no mismatches", () => {
  assert.deepEqual(templateMetadataMismatches(transactional, transactional), []);
});

test("every field that differs is named, with both values", () => {
  const stored = { classification: "service", purpose: "product_updates", requiresUnsubscribe: false };
  assert.deepEqual(templateMetadataMismatches(stored, transactional), [
    { field: "classification", stored: "service", expected: "transactional" },
    { field: "purpose", stored: "product_updates", expected: null },
  ]);
});

test("a marketing definition refuses a stored version without an unsubscribe link", () => {
  const marketing = { classification: "marketing", purpose: "product_updates", requiresUnsubscribe: true };
  assert.deepEqual(
    templateMetadataMismatches({ ...marketing, requiresUnsubscribe: false }, marketing),
    [{ field: "requiresUnsubscribe", stored: false, expected: true }]
  );
});

test("an absent purpose and a null purpose are the same answer", () => {
  assert.deepEqual(
    templateMetadataMismatches(
      { classification: "legal", purpose: undefined, requiresUnsubscribe: false },
      { classification: "legal", purpose: null, requiresUnsubscribe: false }
    ),
    []
  );
});

test("the send metadata is exactly the three fields, whatever else the definition carries", () => {
  assert.deepEqual(
    templateSendMetadata({ ...transactional, key: "x", senderRole: "general" }),
    transactional
  );
});

test("every registered definition agrees with itself through the helper", () => {
  for (const key of EMAIL_TEMPLATE_KEYS) {
    const definition = emailTemplateDefinition(key);
    assert.deepEqual(
      templateMetadataMismatches(templateSendMetadata(definition), definition),
      [],
      key
    );
  }
});
