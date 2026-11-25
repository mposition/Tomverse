import "server-only";
import { prisma } from "@/lib/prisma";

export async function nativeEmailLoginAccountActive(userId: string) {
  const select = { accountStatus: true, accountSuspendedUntil: true } as const;
  let account = await prisma.user.findUnique({ where: { id: userId }, select });
  const now = new Date();
  if (account?.accountStatus === "suspended" && account.accountSuspendedUntil && account.accountSuspendedUntil <= now) {
    await prisma.user.updateMany({
      where: { id: userId, accountStatus: "suspended", accountSuspendedUntil: { lte: now } },
      data: {
        accountStatus: "active", accountSuspendedAt: null, accountSuspendedUntil: null,
        accountSuspensionReason: null, accountSuspendedById: null, accountSuspendedByEmail: null,
      },
    });
    account = await prisma.user.findUnique({ where: { id: userId }, select });
  }
  return account?.accountStatus === "active";
}
