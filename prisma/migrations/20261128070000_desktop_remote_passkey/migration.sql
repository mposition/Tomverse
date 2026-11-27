-- Tomverse Desktop remote control, passkey confirmation (docs/ops/desktop-remote-control.md): a person who
-- registered a passkey confirms "allow once" and a follow-up from another device with it. Two new tables; no existing
-- row, column or constraint is touched.
--
--   DesktopRemotePasskey           one WebAuthn credential of an account: the public key only (the private key never
--                                  leaves the person's authenticator), the relying party it was made for and a counter
--                                  that must rise. At most five per account (checked where it is registered).
--   DesktopRemotePasskeyChallenge  one single-use challenge, valid for two minutes. A challenge for a command is bound
--                                  to the digest of that one command, so an assertion cannot be used for another.
--
-- Both belong to the account and go with it. Rollback (nothing else reads these tables):
--   DROP TABLE "DesktopRemotePasskeyChallenge";
--   DROP TABLE "DesktopRemotePasskey";
BEGIN;

CREATE TABLE "DesktopRemotePasskey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "alg" INTEGER NOT NULL,
    "signCount" BIGINT NOT NULL DEFAULT 0,
    "rpId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMPTZ(3),

    CONSTRAINT "DesktopRemotePasskey_pkey" PRIMARY KEY ("id"),
    -- ES256 and RS256 only; the verifier accepts nothing else.
    CONSTRAINT "DesktopRemotePasskey_alg_check" CHECK ("alg" IN (-7, -257)),
    CONSTRAINT "DesktopRemotePasskey_signCount_check" CHECK ("signCount" BETWEEN 0 AND 4294967295),
    CONSTRAINT "DesktopRemotePasskey_label_check" CHECK (char_length("label") BETWEEN 1 AND 80),
    CONSTRAINT "DesktopRemotePasskey_credentialId_check" CHECK (char_length("credentialId") BETWEEN 16 AND 1400),
    CONSTRAINT "DesktopRemotePasskey_publicKey_check" CHECK (char_length("publicKey") BETWEEN 40 AND 2048)
);

CREATE TABLE "DesktopRemotePasskeyChallenge" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "challenge" TEXT NOT NULL,
    "bindingHash" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "DesktopRemotePasskeyChallenge_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DesktopRemotePasskeyChallenge_purpose_check" CHECK ("purpose" IN ('register', 'enroll', 'command', 'remove')),
    -- Registering binds nothing; confirming an enrollment, a command or a removal is bound to the one thing it confirms.
    CONSTRAINT "DesktopRemotePasskeyChallenge_binding_check" CHECK (("purpose" = 'register') = ("bindingHash" IS NULL)),
    CONSTRAINT "DesktopRemotePasskeyChallenge_challenge_check" CHECK (char_length("challenge") BETWEEN 32 AND 128)
);

CREATE UNIQUE INDEX "DesktopRemotePasskey_credentialId_key" ON "DesktopRemotePasskey"("credentialId");

CREATE INDEX "DesktopRemotePasskey_userId_idx" ON "DesktopRemotePasskey"("userId");

CREATE INDEX "DesktopRemotePasskeyChallenge_userId_expiresAt_idx" ON "DesktopRemotePasskeyChallenge"("userId", "expiresAt");

CREATE INDEX "DesktopRemotePasskeyChallenge_expiresAt_idx" ON "DesktopRemotePasskeyChallenge"("expiresAt");

ALTER TABLE "DesktopRemotePasskey" ADD CONSTRAINT "DesktopRemotePasskey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DesktopRemotePasskeyChallenge" ADD CONSTRAINT "DesktopRemotePasskeyChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
