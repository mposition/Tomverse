export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";

const updateProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(32),
  })
  .strict();

type ProjectRouteContext = {
  params: Promise<{ projectId: string }>;
};

export async function PATCH(req: Request, context: ProjectRouteContext) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }

    const { projectId } = await context.params;
    const userId = session.user.id;
    await consumeApiRateLimit(req, userId, "project-update", {
      minute: 20,
      day: 300,
    });

    const body = await readLimitedJson(req, 4 * 1024, updateProjectSchema);
    const updated = await prisma.conversationProject.updateMany({
      where: { id: projectId, userId },
      data: { name: body.name },
    });
    if (updated.count === 0) {
      return NextResponse.json({ error: "Project not found." }, { status: 404 });
    }

    const project = await prisma.conversationProject.findFirstOrThrow({
      where: { id: projectId, userId },
      select: {
        id: true,
        name: true,
        updatedAt: true,
        _count: { select: { conversations: true } },
      },
    });

    return NextResponse.json({
      id: project.id,
      name: project.name,
      conversationCount: project._count.conversations,
      updatedAt: project.updatedAt.toISOString(),
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "P2002"
    ) {
      return NextResponse.json(
        { error: "A project with this name already exists." },
        { status: 409 }
      );
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "P2025"
    ) {
      return NextResponse.json({ error: "Project not found." }, { status: 404 });
    }
    console.error("Failed to update project:", error);
    return NextResponse.json({ error: "Failed to update project." }, { status: 500 });
  }
}

export async function DELETE(req: Request, context: ProjectRouteContext) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }

    const { projectId } = await context.params;
    const userId = session.user.id;
    await consumeApiRateLimit(req, userId, "project-delete", {
      minute: 10,
      day: 100,
    });

    const deleted = await prisma.conversationProject.deleteMany({
      where: { id: projectId, userId },
    });
    if (deleted.count === 0) {
      return NextResponse.json({ error: "Project not found." }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "P2025"
    ) {
      return NextResponse.json({ error: "Project not found." }, { status: 404 });
    }
    console.error("Failed to delete project:", error);
    return NextResponse.json({ error: "Failed to delete project." }, { status: 500 });
  }
}
