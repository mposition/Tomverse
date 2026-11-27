import type { Prisma } from "@prisma/client";
import { codeCloudBundleKey, codeCloudPatchKey } from "@/lib/codeCloudContract";

/**
 * Account deletion's part for cloud Code jobs, inside the deletion transaction (lib/accountDeletion.ts).
 *
 * The rows go now and both object keys of every job get a tombstone in the shared object cleanup queue that the
 * fifteen-minute maintenance drains (lib/messageAttachmentStorage.ts). Keys derive from the job id, so a bundle or
 * patch whose row had already lost its key is still named. A runner still working on one of these jobs is refused on
 * its next report and stops; the job's credit reservation is anonymised with the rest of the account's Code records.
 */
export async function enqueueCodeCloudCleanupForUser(tx: Prisma.TransactionClient, userId: string) {
  const jobs = await tx.codeCloudJob.findMany({ where: { userId }, select: { id: true } });
  if (jobs.length) {
    await tx.messageAttachmentCleanup.createMany({
      data: jobs.flatMap(({ id }) => [codeCloudBundleKey(id), codeCloudPatchKey(id)].map((objectKey) => ({ objectKey, reason: "account_deleted" }))),
      skipDuplicates: true,
    });
  }
  await tx.codeCloudJob.deleteMany({ where: { userId } });
  return jobs.length;
}
