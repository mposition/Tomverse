import "server-only";

import type { Session } from "next-auth";

const parseCsv = (value: string | undefined) =>
  (value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

export const isAdminSession = (session: Session | null | undefined) => {
  const userId = session?.user?.id?.toLowerCase();
  const email = session?.user?.email?.toLowerCase();
  const adminUserIds = parseCsv(process.env.ADMIN_USER_IDS);
  const adminEmails = parseCsv(process.env.ADMIN_EMAILS);

  return (
    (!!userId && adminUserIds.includes(userId)) ||
    (!!email && adminEmails.includes(email))
  );
};
