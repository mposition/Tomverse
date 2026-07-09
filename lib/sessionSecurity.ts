import "server-only";

import { prisma } from "@/lib/prisma";

export const revokeAllUserSessions = async (userId: string) =>
    prisma.session.deleteMany({
        where: { userId },
    });
