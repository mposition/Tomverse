/**
 * Records the independent review server's status report
 * (lib/reviewOrchestratorStatusCore.ts says what it may hold).
 *
 * One write, the latest report over the previous one. It is telemetry the
 * Agent office reads, not an action: nothing is decided on it, and nothing
 * else in the app reads it.
 */

import "server-only";

import type { PrismaClient } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  REVIEW_ORCHESTRATOR_STATUS_KEY,
  REVIEW_ORCHESTRATOR_STATUS_MAX_BYTES,
  isReviewOrchestratorStatusAuthorized,
  reviewStatusSnapshotSchema,
  storedReviewStatusValue,
} from "@/lib/reviewOrchestratorStatusCore";

export type ReviewStatusAnswer = {
  status: 200 | 400 | 401 | 413;
  body: { result: "recorded" | "invalid" | "unauthorized" | "too_large" };
};

type Db = Pick<PrismaClient, "appSetting">;

export async function recordReviewOrchestratorStatus(
  request: Request,
  env: Readonly<Record<string, string | undefined>> = process.env,
  db: Db = prisma,
  now: () => Date = () => new Date()
): Promise<ReviewStatusAnswer> {
  if (!isReviewOrchestratorStatusAuthorized(request.headers.get("authorization"), env)) {
    return { status: 401, body: { result: "unauthorized" } };
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > REVIEW_ORCHESTRATOR_STATUS_MAX_BYTES) {
    return { status: 413, body: { result: "too_large" } };
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > REVIEW_ORCHESTRATOR_STATUS_MAX_BYTES) {
    return { status: 413, body: { result: "too_large" } };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return { status: 400, body: { result: "invalid" } };
  }
  const snapshot = reviewStatusSnapshotSchema.safeParse(decoded);
  if (!snapshot.success) return { status: 400, body: { result: "invalid" } };

  const value = storedReviewStatusValue(snapshot.data, now());
  await db.appSetting.upsert({
    where: { key: REVIEW_ORCHESTRATOR_STATUS_KEY },
    create: { key: REVIEW_ORCHESTRATOR_STATUS_KEY, value },
    update: { value },
  });
  return { status: 200, body: { result: "recorded" } };
}
