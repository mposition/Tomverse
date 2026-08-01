ALTER TABLE "User"
  ADD COLUMN "accountDeletionRequestedAt" TIMESTAMP(3),
  ADD COLUMN "accountDeletionScheduledFor" TIMESTAMP(3);

CREATE INDEX "User_accountStatus_accountDeletionScheduledFor_idx"
  ON "User"("accountStatus", "accountDeletionScheduledFor");
