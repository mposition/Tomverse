-- The sign-up screen's consent choices, held until the account exists (S4).
-- Contract: docs/policy/email-product-news-redesign-draft.md section 5.2.

CREATE TABLE "SignupConsentAttempt" (
    "id" TEXT NOT NULL,
    "nonceHash" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "bindingProvider" TEXT,
    "bindingEmail" TEXT,
    "bindingEmailLoginAttemptId" TEXT,
    "expressOptInRequested" BOOLEAN NOT NULL,
    "noticeShown" BOOLEAN NOT NULL,
    "objected" BOOLEAN NOT NULL,
    "copyVersion" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "countryCandidates" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    "userId" TEXT,

    CONSTRAINT "SignupConsentAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SignupConsentAttempt_nonceHash_key" ON "SignupConsentAttempt"("nonceHash");
CREATE UNIQUE INDEX "SignupConsentAttempt_userId_key" ON "SignupConsentAttempt"("userId");
CREATE INDEX "SignupConsentAttempt_expiresAt_idx" ON "SignupConsentAttempt"("expiresAt");

ALTER TABLE "SignupConsentAttempt" ADD CONSTRAINT "SignupConsentAttempt_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The two channels, each with its own binding and only its own.
ALTER TABLE "SignupConsentAttempt" ADD CONSTRAINT "SignupConsentAttempt_channel_check"
    CHECK (
        ("channel" = 'oauth'
            AND "bindingProvider" IS NOT NULL
            AND "bindingEmail" IS NULL
            AND "bindingEmailLoginAttemptId" IS NULL)
        OR ("channel" = 'email_code'
            AND "bindingProvider" IS NULL
            AND "bindingEmail" IS NOT NULL)
    );

-- Consumed and superseded are exclusive ends. A consumed attempt names the
-- account that consumed it, and only a consumed one does -- except that the
-- account may later be deleted (SET NULL), which leaves the consumption time
-- standing without the account.
ALTER TABLE "SignupConsentAttempt" ADD CONSTRAINT "SignupConsentAttempt_end_check"
    CHECK (
        NOT ("consumedAt" IS NOT NULL AND "supersededAt" IS NOT NULL)
        AND ("userId" IS NULL OR "consumedAt" IS NOT NULL)
    );

ALTER TABLE "SignupConsentAttempt" ADD CONSTRAINT "SignupConsentAttempt_candidates_check"
    CHECK (jsonb_typeof("countryCandidates") = 'array');
