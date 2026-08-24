import { prisma } from "@/lib/prisma";

/**
 * Turns one of the email feature flags on or off for a test.
 *
 * Written through the same `AppSetting` row production reads, rather than by
 * stubbing the accessor: the thing worth proving is that the switch an operator
 * would flip is the switch the code obeys, and a stub proves only that the code
 * obeys a stub.
 */
export const setEmailFeatureFlag = async (key: string, enabled: boolean) => {
  await prisma.appSetting.upsert({
    where: { key },
    update: { value: enabled ? "true" : "false" },
    create: { key, value: enabled ? "true" : "false" },
  });
};
