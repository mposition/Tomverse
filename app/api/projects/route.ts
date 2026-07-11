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

const createProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(32),
  })
  .strict();

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }

    const userId = session.user.id;
    await consumeApiRateLimit(req, userId, "project-list", {
      minute: 60,
      day: 5_000,
    });

    const projects = await prisma.conversationProject.findMany({
      where: { userId },
      orderBy: [{ updatedAt: "desc" }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        updatedAt: true,
        _count: {
          select: { conversations: true },
        },
      },
    });

    return NextResponse.json({
      projects: projects.map((project) => ({
        id: project.id,
        name: project.name,
        conversationCount: project._count.conversations,
        updatedAt: project.updatedAt.toISOString(),
      })),
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to list projects:", error);
    return NextResponse.json({ error: "Failed to load projects." }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }

    const userId = session.user.id;
    await consumeApiRateLimit(req, userId, "project-create", {
      minute: 10,
      day: 100,
    });

    const body = await readLimitedJson(req, 4 * 1024, createProjectSchema);
    const existingCount = await prisma.conversationProject.count({
      where: { userId },
    });
    if (existingCount >= 24) {
      return NextResponse.json(
        { error: "Project limit reached." },
        { status: 409 }
      );
    }

    const project = await prisma.conversationProject.create({
      data: {
        userId,
        name: body.name,
      },
      select: {
        id: true,
        name: true,
        updatedAt: true,
      },
    });

    return NextResponse.json(
      {
        id: project.id,
        name: project.name,
        conversationCount: 0,
        updatedAt: project.updatedAt.toISOString(),
      },
      { status: 201 }
    );
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
    console.error("Failed to create project:", error);
    return NextResponse.json({ error: "Failed to create project." }, { status: 500 });
  }
}
