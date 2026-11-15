-- Owner decision 2026-11-15: a v22 patch is bounded only by the systems it
-- passes through (lib/amux/v22PatchLimit.ts). Its stored evidence and the
-- engineering agent's copy of it may now hold one patch of up to 4 MiB
-- (4194304 bytes), the most that still fits, JSON-escaped with its Task
-- result, in the 10 MB request body Next.js buffers through proxy.ts. Until
-- now both held 64 KiB. Every other clause is unchanged.
BEGIN;

ALTER TABLE "AmuxV22TaskPatch"
  DROP CONSTRAINT "AmuxV22TaskPatch_digest_check",
  ADD CONSTRAINT "AmuxV22TaskPatch_digest_check" CHECK (
    "digest" ~ '^[0-9a-f]{64}$' AND "patchSha256" ~ '^[0-9a-f]{64}$' AND
    "baseSha" ~ '^[0-9a-f]{40}$' AND
    "digestKeyId" ~ '^[A-Za-z0-9_-]{1,64}$' AND
    "byteLength" BETWEEN 1 AND 4194304
  );

ALTER TABLE "EngineeringAgentWorkItem"
  DROP CONSTRAINT "EngineeringAgentWorkItem_patchBody_check",
  ADD CONSTRAINT "EngineeringAgentWorkItem_patchBody_check"
    CHECK ("patchBody" IS NULL OR octet_length("patchBody") <= 4194304);

COMMIT;
