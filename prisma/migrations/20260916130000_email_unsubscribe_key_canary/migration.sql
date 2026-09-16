-- Which unsubscribe key a sent message depends on, and a way to prove that key
-- still opens its links.
--
-- Contract: docs/policy/email-notifications.md §11.4.
--
-- Unsubscribe tokens do not expire; a link works for as long as its key version
-- stays in EMAIL_UNSUBSCRIBE_KEYS. Nothing recorded which version a message was
-- sent under, and tokens use a random IV and are not stored, so there was no
-- way to say when a version could be retired or to test that one still worked.
--
-- `EmailDelivery.unsubscribeKeyVersion` records the version of the link in the
-- message that was actually sent. `EmailUnsubscribeKeyCanary` holds one inert
-- token per version, minted with that key the first time it signs a real link.
-- Readiness decrypts every canary against the live keyring and refuses a
-- deployment that dropped or changed a version used in the last thirty days.
--
-- The canary acts on nobody: its subject is not an account id and its purpose
-- is not a purpose. The check only decrypts it and never calls the endpoint.

ALTER TABLE "EmailDelivery" ADD COLUMN "unsubscribeKeyVersion" TEXT;

CREATE INDEX "EmailDelivery_unsubscribeKeyVersion_sentAt_idx"
    ON "EmailDelivery"("unsubscribeKeyVersion", "sentAt");

CREATE TABLE "EmailUnsubscribeKeyCanary" (
    "id" TEXT NOT NULL,
    "keyVersion" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailUnsubscribeKeyCanary_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmailUnsubscribeKeyCanary_keyVersion_key"
    ON "EmailUnsubscribeKeyCanary"("keyVersion");
