export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { deleteTomverseAccount } from "@/lib/accountDeletion";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { isAdminSession } from "@/lib/adminAuth";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";

const deleteUserSchema = z
  .object({
    confirm: z.literal(true),
  })
  .strict();

type RouteContext = {
  params: Promise<{ userId: string }>;
};

export async function DELETE(req: Request, context: RouteContext) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    await consumeApiRateLimit(req, session.user.id, "admin-user-delete", {
      minute: 5,
      day: 50,
    });

    const { userId } = await context.params;
    if (userId === session.user.id) {
      return NextResponse.json(
        { error: "Admins cannot delete their own account from the admin console." },
        { status: 400 }
      );
    }

    await readLimitedJson(req, 1024, deleteUserSchema);
    const result = await deleteTomverseAccount(userId);
    if (!result.deleted) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }

    await writeAdminAuditLog({
      session,
      request: req,
      action: "user.deleted",
      targetType: "User",
      targetId: userId,
      summary: `Deleted user account ${result.email || userId}.`,
      metadata: {
        email: result.email || null,
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Admin user deletion failed:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? `Failed to delete user: ${error.message}`
            : "Failed to delete user.",
      },
      { status: 500 }
    );
  }
}
