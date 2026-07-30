-- Session-invalidation epoch for JWT sessions.
--
-- Sessions are issued with `session.strategy = "jwt"`, so NextAuth never writes
-- a row to "Session". revokeAllUserSessions() previously deleted from that
-- always-empty table, which made suspension, forced sign-out and OAuth unlink
-- no-ops: a revoked user kept full API access until their token expired.
--
-- Any token whose issue time is at or before "sessionsRevokedAt" is now
-- rejected during session resolution. NULL means nothing has been revoked.
ALTER TABLE "User"
  ADD COLUMN "sessionsRevokedAt" TIMESTAMP(3);
