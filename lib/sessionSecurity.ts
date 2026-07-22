import "server-only";

import { prisma } from "@/lib/prisma";

// The app uses session.strategy "jwt", so deleting Session table rows alone
// has nothing to delete and cannot force other devices to log out. Stamping
// sessionsInvalidatedAt is the real mechanism: callbacks.session in lib/auth.ts
// checks it on every request and treats any JWT minted before this timestamp
// as signed-out. The Session-row deletion is kept alongside it for hygiene
// (harmless no-op today, cheap insurance if a future change ever introduces
// database sessions).
export const revokeAllUserSessions = async (userId: string) => {
    await prisma.$transaction([
        prisma.session.deleteMany({ where: { userId } }),
        prisma.user.update({
            where: { id: userId },
            data: { sessionsInvalidatedAt: new Date() },
        }),
    ]);
};
