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
    })
    .strict(),
]);
