export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { deleteTomverseAccount } from "@/lib/accountDeletion";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";

const deleteAccountSchema = z
  .object({
    confirm: z.literal(true),
  })
  .strict();

export async function DELETE(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required." },
        { status: 401 }
      );
    }

    await consumeApiRateLimit(req, session.user.id, "user-account-delete", {
      minute: 2,
      day: 3,
    });

    await readLimitedJson(req, 1024, deleteAccountSchema);
    await deleteTomverseAccount(session.user.id);

    return NextResponse.json({ success: true });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Account deletion failed:", error);
    return NextResponse.json(
      { error: "Failed to delete account." },
      { status: 500 }
    );
  }
}
