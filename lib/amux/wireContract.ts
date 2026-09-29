import { z } from "zod";

import {
  AMUX_PRISMA_INT_MAX,
  amuxMachineIdSchema,
} from "@/lib/amux/claimContract";
import {
  AMUX_OWNED_QUEUE_MAX_ITEMS,
  AMUX_QUEUE_MAX_ITEMS,
} from "@/lib/amux/store";

const prismaInt = z.number().int().min(0).max(AMUX_PRISMA_INT_MAX);
const timestamp = z.string().datetime({ offset: true });
const unitSignal = z.number().min(0).max(1).nullable();

export const amuxQueueResponseSchema = z
  .array(
    z
      .object({
        id: amuxMachineIdSchema,
        kind: z.string().min(1).max(64),
        priority: z.string().min(1).max(32),
        pinned: z.boolean(),
        drag: z.number().int().min(0).max(8),
        revision: prismaInt,
        created_at: timestamp,
        dependent_count: prismaInt,
        scheduler_score: z.number().int().min(0).max(6_010_428),
        scoring_version: z.literal("amux-global-priority-v2"),
        scheduler_signals: z
          .object({
            pin: z.number().int().min(0).max(10_000),
            age_hours: z.number().int().min(0).max(1_000_000),
            type_weight: z.number().int().min(0).max(40),
            priority_weight: z.number().int().min(0).max(40),
            dependents: prismaInt,
            dependent_weight: z.number().int().min(0).max(5_000_000),
            drag: z.number().int().min(0).max(8),
            urgency: z.number().int().min(0).max(240),
            capacity_weight: z.number().int().min(0).max(20),
            incident_bonus: z.number().int().min(0).max(80),
            total: z.number().int().min(0).max(6_010_428),
          })
          .strict(),
      })
      .strict(),
  )
  .max(AMUX_QUEUE_MAX_ITEMS);

export const amuxOwnedQueueResponseSchema = z
  .array(
    z
      .object({
        id: amuxMachineIdSchema,
        owner: amuxMachineIdSchema,
        revision: prismaInt,
      })
      .strict(),
  )
  .max(AMUX_OWNED_QUEUE_MAX_ITEMS);

const workerSchema = z
  .object({
    worker_name: amuxMachineIdSchema,
    provider: z.string().min(1).max(80),
    model: z.string().max(160).nullable(),
    routing_roles: z.array(z.string().min(1).max(64)).max(64),
    running: z.boolean(),
    status: z.string().min(1).max(32),
    dispatch_ready: z.boolean(),
    archived: z.boolean(),
    paused: z.boolean(),
    isolated: z.boolean(),
    blocked: z.boolean(),
  })
  .strict();

const routingCandidateSchema = z
  .object({
    worker: workerSchema,
    predicted_success: unitSignal,
    quota_remaining: unitSignal,
    expected_speed: unitSignal,
    low_rework: unitSignal,
    low_human_attention: unitSignal,
    cost_efficiency: unitSignal,
    provider_exhausted: z.boolean(),
  })
  .strict();

const observedRoutingMetricSchema = z
  .object({
    value: z.number().min(0).max(1),
    raw_value: z.number().min(0).max(1).nullable(),
    confidence: z.number().min(0).max(1),
    observed: z.boolean(),
    source: z
      .enum([
        "historical_attempts",
        "historical_cost",
        "provider_api",
        "wrapper",
      ])
      .nullable(),
    sample_size: prismaInt.nullable(),
    observed_at: timestamp.nullable(),
  })
  .strict();

const quotaTelemetrySchema = z.union([
  observedRoutingMetricSchema.extend({
    state: z.enum(["unknown", "fresh", "stale", "invalid"]),
    provider_exhausted: z.boolean(),
    reset_at: timestamp.nullable(),
  }),
  z
    .object({
      state: z.literal("unknown"),
      provider_exhausted: z.literal(false),
    })
    .strict(),
]);

const routingTelemetrySchema = z
  .record(
    amuxMachineIdSchema,
    z
      .object({
        history: z
          .object({
            sample_size: prismaInt,
            predicted_success: observedRoutingMetricSchema.optional(),
            expected_speed: observedRoutingMetricSchema.optional(),
            low_rework: observedRoutingMetricSchema.optional(),
            low_human_attention: observedRoutingMetricSchema.optional(),
            cost_efficiency: observedRoutingMetricSchema.optional(),
          })
          .strict(),
        quota: quotaTelemetrySchema,
      })
      .strict(),
  )
  .refine((value) => Object.keys(value).length <= 128, {
    message: "Routing telemetry exceeds the worker catalog bound.",
  });

export const amuxRoutingResponseSchema = z.discriminatedUnion("eligible", [
  z
    .object({
      eligible: z.literal(false),
      execution_ready: z.literal(false),
      reason: z.enum([
        "not_eligible",
        "unclassified",
        "worker_catalog_unavailable",
      ]),
      task: z.null(),
      candidates: z.tuple([]),
      telemetry: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      eligible: z.literal(true),
      execution_ready: z.boolean(),
      reason: z.null(),
      task: z
        .object({
          task_kind: z.string().min(1).max(64),
          complexity: z.number().int().min(0).max(10),
          risk: z.number().int().min(0).max(10),
          files_expected: z.number().int().min(0).max(100_000).nullable(),
        })
        .strict(),
      candidates: z.array(routingCandidateSchema).max(128),
      telemetry: routingTelemetrySchema,
    })
    .strict(),
]);
