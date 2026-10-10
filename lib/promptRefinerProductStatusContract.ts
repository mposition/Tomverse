import { z } from "zod";

export const PROMPT_REFINER_PRODUCT_STATUS_PATH =
  "/api/admin/prompt-refiner/product-status";

export const PROMPT_REFINER_PRODUCT_STATUS_VERSION =
  "prompt-refiner-product-status-v1" as const;

const routerGate = z.enum([
  "shadow_report",
  "offline_quality_evaluation",
  "attempt_manifest_boundary",
]);

export const promptRefinerProductStatusSchema = z.object({
  version: z.literal(PROMPT_REFINER_PRODUCT_STATUS_VERSION),
  observedAt: z.string().datetime({ offset: true }),
  serving: z.object({
    commitSha: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
    deploymentId: z.string().min(1).max(128).nullable(),
    exactProductIdentity: z.boolean(),
  }).strict(),
  controls: z.object({
    rollout: z.enum(["enabled", "disabled", "unknown"]),
    killSwitchEngaged: z.boolean(),
  }).strict(),
  release: z.object({
    state: z.enum([
      "verified",
      "disabled_by_rollout",
      "blocked_by_kill_switch",
      "runtime_identity_unavailable",
      "closed_or_unavailable",
      "unavailable",
    ]),
    explicitEnabled: z.boolean().nullable(),
    autoEnabled: z.boolean().nullable(),
    approvalAuditLogId: z.string().min(1).max(128).nullable(),
  }).strict(),
  router: z.object({
    version: z.string().min(1).max(128),
    ready: z.boolean(),
    outstanding: z.array(routerGate).max(3),
    problems: z.array(z.string().min(1).max(512)).max(32),
  }).strict(),
  completionClaim: z.literal("not_established_by_status_readback"),
}).strict();

export type PromptRefinerProductStatus = z.infer<
  typeof promptRefinerProductStatusSchema
>;

export const parsePromptRefinerProductStatus = (
  value: unknown
): PromptRefinerProductStatus | null => {
  const parsed = promptRefinerProductStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};
