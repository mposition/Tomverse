import type { AdminUserRow } from "@/lib/adminUserTypes";

const escapeSpreadsheetCell = (value: unknown) => {
  let text = String(value ?? "");
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
};

export const adminUsersCsv = (users: AdminUserRow[]) => {
  const rows: unknown[][] = [
    [
      "id",
      "email",
      "name",
      "createdAt",
      "accessPlan",
      "subscriptionStatus",
      "subscriptionPeriodEnd",
      "cancelAtPeriodEnd",
      "stripeCustomerId",
      "stripeSubscriptionId",
      "billingRiskStatus",
      "creditDebtCredits",
      "creditDebtCostMicroUsd",
      "conversations",
      "linkedAccounts",
      "refundRequests",
      "promotionRedemptions",
      "usageToday",
    ],
    ...users.map((user) => [
      user.id,
      user.email || "",
      user.name || "",
      user.createdAt || "",
      user.plan || "Free",
      user.subscriptionStatus || "",
      user.subscriptionCurrentPeriodEnd || "",
      user.subscriptionCancelAtPeriodEnd,
      user.stripeCustomerId || "",
      user.stripeSubscriptionId || "",
      user.billingRiskStatus,
      user.creditDebtCredits,
      user.creditDebtCostMicroUsd,
      user._count.conversations,
      user._count.accounts,
      user._count.refundRequests,
      user._count.promotionRedemptions,
      user.usageToday,
    ]),
  ];

  return `\uFEFF${rows
    .map((row) => row.map(escapeSpreadsheetCell).join(","))
    .join("\r\n")}`;
};
