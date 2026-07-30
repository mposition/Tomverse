CREATE TABLE "EmailLoginAttempt" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "linkTokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "invalidatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailLoginAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmailLoginAttempt_linkTokenHash_key" ON "EmailLoginAttempt"("linkTokenHash");

CREATE INDEX "EmailLoginAttempt_email_consumedAt_invalidatedAt_expiresAt_idx" ON "EmailLoginAttempt"("email", "consumedAt", "invalidatedAt", "expiresAt");

CREATE INDEX "EmailLoginAttempt_expiresAt_idx" ON "EmailLoginAttempt"("expiresAt");
