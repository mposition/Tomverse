export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { APP_DEFAULTS } from "@/lib/appDefaults";
import {
  MODEL_FINDER_PRIORITIES,
  MODEL_FINDER_TASKS,
  getModelFinderCombination,
  isModelFinderDefaultId,
} from "@/lib/modelFinder";
import { prisma } from "@/lib/prisma";

const answersSchema = z
  .object({
    tasks: z
      .array(z.enum(MODEL_FINDER_TASKS))
      .min(1)
      .max(MODEL_FINDER_TASKS.length),
    priority: z.enum(MODEL_FINDER_PRIORITIES),
  })
  .strict();

const actionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("complete"),
      answers: answersSchema,
      modelIds: z.array(z.string().trim().min(1).max(100)).min(1).max(3),
    })
    .strict(),
  z.object({ action: z.literal("accept_default") }).strict(),
]);

const noStoreHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
};

const toStoredTasks = (value: unknown) =>
  Array.isArray(value)
    ? value.filter(
        (task): task is (typeof MODEL_FINDER_TASKS)[number] =>
          typeof task === "string" &&
          MODEL_FINDER_TASKS.includes(
            task as (typeof MODEL_FINDER_TASKS)[number]
          )
      )
    : [];

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required." },
        { status: 401, headers: noStoreHeaders }
      );
    }

    const userId = session.user.id;
    await consumeApiRateLimit(req, userId, "model-finder-read", {
      minute: 30,
      day: 500,
    });

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        settings: {
          select: {
            preferredTasks: true,
            preferredPriority: true,
            defaultModel: true,
            modelFinderCompletedAt: true,
          },
        },
      },
    });

    if (!user) {
      return NextResponse.json(
        { error: "Account not found." },
        { status: 404, headers: noStoreHeaders }
      );
    }

    return NextResponse.json(
      {
        settings: {
          preferredTasks: toStoredTasks(user.settings?.preferredTasks),
          preferredPriority: user.settings?.preferredPriority || null,
          defaultModelId:
            user.settings?.defaultModel || APP_DEFAULTS.defaultModelId,
          modelFinderCompletedAt:
            user.settings?.modelFinderCompletedAt?.toISOString() || null,
        },
      },
      { headers: noStoreHeaders }
    );
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to load model finder settings:", error);
    return NextResponse.json(
      { error: "Failed to load model finder settings." },
      { status: 500, headers: noStoreHeaders }
    );
  }
}

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required." },
        { status: 401, headers: noStoreHeaders }
      );
    }

    const userId = session.user.id;
    await consumeApiRateLimit(req, userId, "model-finder-save", {
      minute: 10,
      day: 100,
    });
    const body = await readLimitedJson(req, 8 * 1024, actionSchema);
    const actionAt = new Date();

    if (body.action === "accept_default") {
      const defaultModelId = isModelFinderDefaultId(APP_DEFAULTS.defaultModelId)
        ? APP_DEFAULTS.defaultModelId
        : "gpt-5-4-mini";
      const settings = await prisma.userSettings.upsert({
        where: { userId },
        update: {
          defaultModel: defaultModelId,
          modelFinderCompletedAt: actionAt,
        },
        create: {
          userId,
          defaultModel: defaultModelId,
          modelFinderCompletedAt: actionAt,
        },
      });
      return NextResponse.json(
        {
          success: true,
          defaultModelId: settings.defaultModel,
          modelIds: [settings.defaultModel],
          modelFinderCompletedAt: settings.modelFinderCompletedAt?.toISOString(),
        },
        { headers: noStoreHeaders }
      );
    }

    const combo = getModelFinderCombination(body.answers);
    const comboModelIds = new Set(combo.map((pick) => pick.modelId));
    if (
      !body.modelIds.length ||
      !body.modelIds.every((modelId) => comboModelIds.has(modelId))
    ) {
      return NextResponse.json(
        { error: "One or more selected models are not part of the recommended combination." },
        { status: 400, headers: noStoreHeaders }
      );
    }

    const settings = await prisma.userSettings.upsert({
      where: { userId },
      update: {
        preferredTasks: body.answers.tasks,
        preferredPriority: body.answers.priority,
        usesFilesFrequently: "rarely",
        defaultModel: body.modelIds[0],
        modelFinderCompletedAt: actionAt,
      },
      create: {
        userId,
        preferredTasks: body.answers.tasks,
        preferredPriority: body.answers.priority,
        usesFilesFrequently: "rarely",
        defaultModel: body.modelIds[0],
        modelFinderCompletedAt: actionAt,
      },
    });

    return NextResponse.json(
      {
        success: true,
        defaultModelId: settings.defaultModel,
        modelIds: body.modelIds,
        modelFinderCompletedAt: settings.modelFinderCompletedAt?.toISOString(),
      },
      { headers: noStoreHeaders }
    );
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to save model finder settings:", error);
    return NextResponse.json(
      { error: "Failed to save model finder settings." },
      { status: 500, headers: noStoreHeaders }
    );
  }
}
