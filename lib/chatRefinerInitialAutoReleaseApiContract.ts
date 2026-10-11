import { z } from "zod";

export const CHAT_REFINER_INITIAL_AUTO_ACTIVATION_PATH =
  "/api/admin/prompt-refiner/product-activation" as const;
export const CHAT_REFINER_INITIAL_AUTO_ROLLOUT_PATH =
  "/api/admin/prompt-refiner/product-rollout" as const;

export const CHAT_REFINER_INITIAL_AUTO_ACTIVATION_CONFIRMATION =
  "ACTIVATE_EXACT_CHAT_REFINER_INITIAL_AUTO_RELEASE" as const;
export const CHAT_REFINER_INITIAL_AUTO_ROLLOUT_CONFIRMATIONS = Object.freeze({
  enabled: "ENABLE_EXACT_CHAT_REFINER_INITIAL_AUTO_ROLLOUT",
  disabled: "DISABLE_CHAT_REFINER_INITIAL_AUTO_ROLLOUT",
} as const);

const runtime = {
  runtimeCommitSha: z.string().regex(/^[0-9a-f]{40}$/),
  runtimeDeploymentId: z.string().uuid(),
};

export const chatRefinerInitialAutoEvidenceRefsSchema = z.object({
  independentReviewJobId: z.string()
    .regex(/^r-\d{8}-\d{6}-[0-9a-f]{6}$/),
  validationSealSha256: z.string().regex(/^[0-9a-f]{64}$/),
  deploymentReadbackSha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

export type ChatRefinerInitialAutoEvidenceRefs = z.infer<
  typeof chatRefinerInitialAutoEvidenceRefsSchema>;

export const chatRefinerInitialAutoActivationRequestSchema = z.object({
  releaseKind: z.literal("initial_auto_v1"),
  ...runtime,
  evidenceRefs: chatRefinerInitialAutoEvidenceRefsSchema,
  confirmation: z.literal(CHAT_REFINER_INITIAL_AUTO_ACTIVATION_CONFIRMATION),
}).strict();

export const chatRefinerInitialAutoRolloutRequestSchema = z.discriminatedUnion(
  "enabled",
  [
    z.object({ enabled: z.literal(true), ...runtime,
      confirmation: z.literal(
        CHAT_REFINER_INITIAL_AUTO_ROLLOUT_CONFIRMATIONS.enabled),
    }).strict(),
    z.object({ enabled: z.literal(false), ...runtime,
      confirmation: z.literal(
        CHAT_REFINER_INITIAL_AUTO_ROLLOUT_CONFIRMATIONS.disabled),
    }).strict(),
  ],
);

export const chatRefinerInitialAutoActivationResponseSchema = z.object({
  releaseKind: z.literal("initial_auto_v1"),
  routerActivationAuditLogId: z.string().min(1).max(128),
  productActivationAuditLogId: z.string().min(1).max(128),
  runtimeCommitSha: z.string().regex(/^[0-9a-f]{40}$/),
  runtimeDeploymentId: z.string().uuid(),
  rolloutChanged: z.literal(false),
}).strict();

export const chatRefinerInitialAutoRolloutResponseSchema = z.object({
  enabled: z.boolean(),
  changed: z.boolean(),
  auditLogId: z.string().min(1).max(128),
  runtimeCommitSha: z.string().regex(/^[0-9a-f]{40}$/),
  runtimeDeploymentId: z.string().uuid(),
}).strict();

export type ChatRefinerInitialAutoActivationResponse = z.infer<
  typeof chatRefinerInitialAutoActivationResponseSchema>;
export type ChatRefinerInitialAutoRolloutResponse = z.infer<
  typeof chatRefinerInitialAutoRolloutResponseSchema>;
