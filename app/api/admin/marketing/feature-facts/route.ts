export const dynamic = "force-dynamic";

import { runMarketingAdminMutation } from "@/lib/marketingAdminMutations";
import { createMarketingFeatureFact, updateMarketingFeatureFact } from "@/lib/marketingFeatureFacts";
import {
  MARKETING_FEATURE_FACT_ACTIONS,
  marketingFeatureFactCreateSchema,
  MarketingFeatureFactRefusedError,
  marketingFeatureFactUpdateSchema,
} from "@/lib/marketingFeatureFactsCore";

/**
 * The ad facts list (lib/marketingFeatureFactsCore.ts): what the box's
 * Higgsfield image job may say about each feature. The console page reads it
 * on the server; POST adds an entry and PATCH changes one, both through
 * runMarketingAdminMutation (marketing:write, a recent sign-in, the audit
 * entry in the same transaction). Neither is refused by a switch: a hold put
 * on during an incident is how an operator stops ads about a feature.
 */
// The edit schemas take what an operator edits and nothing else: no
// `disclosure`, no recorded example, no position (lib/marketingFeatureFactsCore.ts).
const createSchema = marketingFeatureFactCreateSchema;
const updateSchema = marketingFeatureFactUpdateSchema;

const refusal = (error: unknown) =>
  error instanceof MarketingFeatureFactRefusedError
    ? { code: error.code, status: error.status, message: error.message }
    : null;

export async function POST(req: Request) {
  return runMarketingAdminMutation({
    request: req,
    action: MARKETING_FEATURE_FACT_ACTIONS.create,
    targetType: "MarketingFeatureFact",
    targetId: (body) => body.id,
    summary: (body) => `Added the ad fact ${body.id}.`,
    gate: "operator_restriction",
    bucket: "admin-marketing-feature-fact-create",
    schema: createSchema,
    metadata: (body) => ({ id: body.id, fields: body }),
    refusal,
    run: (tx, { body }) => createMarketingFeatureFact(tx, body),
  });
}

export async function PATCH(req: Request) {
  return runMarketingAdminMutation({
    request: req,
    action: MARKETING_FEATURE_FACT_ACTIONS.update,
    targetType: "MarketingFeatureFact",
    targetId: (body) => body.id,
    summary: (body) => `Changed the ad fact ${body.id}.`,
    gate: "operator_restriction",
    bucket: "admin-marketing-feature-fact-update",
    schema: updateSchema,
    // The previous values are the row's, read in the same transaction, so the
    // entry says what the change replaced.
    metadata: async (body, tx) => ({
      id: body.id,
      before: await tx.marketingFeatureFact.findUnique({
        where: { id: body.id },
        select: { what: true, models: true, copy: true, source: true, hold: true },
      }),
      after: { what: body.what, models: body.models, copy: body.copy, source: body.source, hold: body.hold },
    }),
    refusal,
    run: (tx, { body }) => updateMarketingFeatureFact(tx, body),
  });
}
