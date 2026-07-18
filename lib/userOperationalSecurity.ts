import "server-only";

import { prisma } from "@/lib/prisma";

export class UserOperationalRestrictionError extends Error {
  code: "ACCOUNT_SUSPENDED" | "ACCOUNT_PENDING_DELETION" | "AI_USAGE_RESTRICTED";

  constructor(
    code: "ACCOUNT_SUSPENDED" | "ACCOUNT_PENDING_DELETION" | "AI_USAGE_RESTRICTED",
    message: string
  ) {
    super(message);
    this.name = "UserOperationalRestrictionError";
    this.code = code;
  }
}

export async function enforceUserOperationalSecurity(userId: string) {
  const now = new Date();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      accountStatus: true,
      accountSuspendedUntil: true,
      accountSuspensionReason: true,
      aiUsageRestricted: true,
      aiUsageRestrictedUntil: true,
      aiUsageRestrictionReason: true,
    },
  });
  if (!user) return;
  if (user.accountStatus === "pending_deletion") {
    throw new UserOperationalRestrictionError(
      "ACCOUNT_PENDING_DELETION",
      "This account is scheduled for deletion and cannot use AI services."
    );
  }
  const suspensionExpired =
    user.accountStatus === "suspended" &&
    user.accountSuspendedUntil !== null &&
    user.accountSuspendedUntil <= now;
  const aiRestrictionExpired =
    user.aiUsageRestricted &&
    user.aiUsageRestrictedUntil !== null &&
    user.aiUsageRestrictedUntil <= now;
  if (suspensionExpired || aiRestrictionExpired) {
    await prisma.user.update({
      where: { id: userId },
      data: {
        ...(suspensionExpired
          ? {
              accountStatus: "active",
              accountSuspendedUntil: null,
              accountSuspensionReason: null,
              accountSuspendedAt: null,
              accountSuspendedById: null,
              accountSuspendedByEmail: null,
            }
          : {}),
        ...(aiRestrictionExpired
          ? {
              aiUsageRestricted: false,
              aiUsageRestrictedUntil: null,
              aiUsageRestrictionReason: null,
              aiUsageRestrictedAt: null,
              aiUsageRestrictedById: null,
              aiUsageRestrictedByEmail: null,
            }
          : {}),
      },
    });
  }
  if (user.accountStatus === "suspended" && !suspensionExpired) {
    throw new UserOperationalRestrictionError(
      "ACCOUNT_SUSPENDED",
      user.accountSuspensionReason || "This account is temporarily suspended."
    );
  }
  if (user.aiUsageRestricted && !aiRestrictionExpired) {
    throw new UserOperationalRestrictionError(
      "AI_USAGE_RESTRICTED",
      user.aiUsageRestrictionReason || "AI usage is temporarily restricted."
    );
  }
}
