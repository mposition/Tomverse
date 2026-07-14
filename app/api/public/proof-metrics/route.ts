export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const PUBLIC_COUNT_THRESHOLD = 20;

const publicCount = (count: number) =>
  count >= PUBLIC_COUNT_THRESHOLD ? Math.floor(count / 10) * 10 : null;

export async function GET() {
  const generatedAt = new Date();
  const thirtyDaysAgo = new Date(
    generatedAt.getTime() - 30 * 24 * 60 * 60 * 1000
  );

  try {
    const [comparisonCount, fileWorkflowCount] = await Promise.all([
      prisma.productAnalyticsEvent.count({
        where: {
          eventName: "multi_model_compare_completed",
          modelCount: { gte: 2 },
          occurredAt: { gte: thirtyDaysAgo },
        },
      }),
      prisma.productAnalyticsEvent.count({
        where: {
          eventName: "file_attached",
          occurredAt: { gte: thirtyDaysAgo },
        },
      }),
    ]);

    return NextResponse.json(
      {
        periodDays: 30,
        generatedAt: generatedAt.toISOString(),
        comparisons: publicCount(comparisonCount),
        fileWorkflows: publicCount(fileWorkflowCount),
        minimumPublicCount: PUBLIC_COUNT_THRESHOLD,
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=300, stale-while-revalidate=3600",
        },
      }
    );
  } catch (error) {
    console.error("Public product proof metrics query failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      {
        periodDays: 30,
        generatedAt: generatedAt.toISOString(),
        comparisons: null,
        fileWorkflows: null,
        minimumPublicCount: PUBLIC_COUNT_THRESHOLD,
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
        },
      }
    );
  }
}
