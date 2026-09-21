import { z } from "zod";

export const AMUX_MACHINE_ID_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,118}[A-Za-z0-9])?$/;
export const AMUX_PRISMA_INT_MAX = 2_147_483_647;
export const AMUX_MAX_EXPECTED_REVISION = AMUX_PRISMA_INT_MAX - 1;
export const AMUX_MAX_SCHEDULER_SCORE = 6_010_088;

export const amuxMachineIdSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(AMUX_MACHINE_ID_PATTERN);

const schedulerSignalsSchema = z
  .object({
    pin: z.number().int().min(0).max(10_000),
    age_hours: z.number().int().min(0).max(1_000_000),
    type_weight: z.number().int().min(0).max(40),
    priority_weight: z.number().int().min(0).max(40),
    dependents: z.number().int().min(0).max(1_000_000),
    dependent_weight: z.number().int().min(0).max(5_000_000),
    drag: z.number().int().min(0).max(8),
  })
  .strict();

const unitScore = z.number().min(0).max(1);

const metricSchema = z
  .object({
    value: unitScore,
    observed: z.boolean(),
  })
  .strict();

const taskFitSchema = z
  .object({
    role_fit: unitScore,
    provider_fit: unitScore,
    combined: unitScore,
    large_task: z.boolean(),
  })
  .strict();

const candidateSchema = z
  .object({
    worker_name: amuxMachineIdSchema,
    provider: z.string().trim().min(1).max(80),
    breakdown: z
      .object({
        task_fit: taskFitSchema,
        predicted_success: metricSchema,
        quota_remaining: metricSchema,
        expected_speed: metricSchema,
        low_rework: metricSchema,
        low_human_attention: metricSchema,
        cost_efficiency: metricSchema,
        selected_score: unitScore,
        intrinsic_score: unitScore,
        operationally_allowed: z.boolean(),
        provider_exhausted: z.boolean(),
        selected_eligible: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const amuxRoutingEvidenceSchema = z
  .object({
    scoring_version: z.literal("amux-worker-router-v1"),
    preferred_worker: amuxMachineIdSchema.nullable(),
    selected_worker: amuxMachineIdSchema.nullable(),
    preferred_score: unitScore.nullable(),
    selected_score: unitScore.nullable(),
    candidates: z.array(candidateSchema).min(1).max(128),
  })
  .strict();

const signalsSchema = z
  .object({
    scheduler: schedulerSignalsSchema,
    routing: amuxRoutingEvidenceSchema,
  })
  .strict();

export const amuxClaimRequestSchema = z
  .object({
    task_id: amuxMachineIdSchema,
    worker: amuxMachineIdSchema,
    expected_revision: z.number().int().min(0).max(AMUX_MAX_EXPECTED_REVISION),
    decision: z
      .object({
        scheduler_score: z.number().int().min(0).max(AMUX_MAX_SCHEDULER_SCORE),
        scoring_version: z.literal("amux-global-priority-v1"),
        signals: signalsSchema,
      })
      .strict(),
  })
  .strict();

export type AmuxRoutingEvidence = z.infer<typeof amuxRoutingEvidenceSchema>;

export type AmuxClaimRequest = z.infer<typeof amuxClaimRequestSchema>;

export const parseAmuxClaimRequest = (input: unknown) =>
  amuxClaimRequestSchema.safeParse(input);
