/**
 * The three values a send is decided by, and whether a stored version still
 * carries the ones the code sends under.
 *
 * Contract: docs/policy/email-notifications.md §10.2.
 *
 * Pure and dependency-free so the comparison can be driven in tests without a
 * database, and shared by the registry (which writes them) and the drain (which
 * refuses a version that disagrees).
 */

export type TemplateSendMetadata = {
  classification: string;
  purpose: string | null;
  requiresUnsubscribe: boolean;
};

export const templateSendMetadata = (definition: TemplateSendMetadata): TemplateSendMetadata => ({
  classification: definition.classification,
  purpose: definition.purpose ?? null,
  requiresUnsubscribe: definition.requiresUnsubscribe,
});

export type TemplateMetadataMismatch = {
  field: keyof TemplateSendMetadata;
  stored: string | boolean | null;
  expected: string | boolean | null;
};

/**
 * Every field where the stored version differs from the definition, or an
 * empty list.
 *
 * Exact comparison, no normalisation beyond `undefined` to `null` for purpose.
 * A version published under a different classification is a version whose
 * footer, headers, stream and suppression rules were decided under that other
 * classification; sending it as though it were this one is the defect the
 * comparison exists to stop.
 */
export const templateMetadataMismatches = (
  stored: TemplateSendMetadata,
  definition: TemplateSendMetadata
): TemplateMetadataMismatch[] => {
  const expected = templateSendMetadata(definition);
  const actual = templateSendMetadata(stored);
  const fields: Array<keyof TemplateSendMetadata> = [
    "classification",
    "purpose",
    "requiresUnsubscribe",
  ];
  return fields
    .filter((field) => actual[field] !== expected[field])
    .map((field) => ({ field, stored: actual[field], expected: expected[field] }));
};
