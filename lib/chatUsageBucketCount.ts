/**
 * `ChatUsageBucket."count"` is a BigInt column.
 *
 * It has to be: the same counter carries request counts, token counts *and*
 * the operational cost guardrails, which are stored in micro-USD and derived
 * from the plan's own credit grant. The Max plan's default 10,000 monthly
 * credits produce a monthly total-cost guardrail of 2,500,000,000 micro-USD,
 * past int4's ceiling -- see
 * `prisma/migrations/20260801130000_widen_chat_usage_bucket_count`.
 *
 * Every consumer works in plain numbers, and a `bigint` reaching
 * `NextResponse.json()` throws `Do not know how to serialize a BigInt`, so the
 * value is narrowed once, at the point it is read.
 *
 * The realistic ceiling is around 1e10 micro-USD, far inside `Number`'s exact
 * integer range. A value that is not a safe integer means the counter has
 * gone somewhere it was never meant to, and is worth failing on rather than
 * rounding silently.
 */
export const usageBucketCount = (
  value: bigint | number | null | undefined
): number => {
  if (value === null || value === undefined) return 0;
  const count = Number(value);
  if (!Number.isSafeInteger(count)) {
    throw new Error("Chat usage bucket count exceeds the supported range.");
  }
  return count;
};
