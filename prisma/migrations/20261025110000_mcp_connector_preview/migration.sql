CREATE TABLE "McpConnection" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "serverId" TEXT NOT NULL, "policyDigest" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'connected', "credentialCiphertext" TEXT, "oauthCiphertext" TEXT,
  "catalog" JSONB NOT NULL, "grants" JSONB NOT NULL DEFAULT '[]',
  "version" INTEGER NOT NULL DEFAULT 1, "leaseId" TEXT, "leaseUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "McpConnection_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "McpConnection_status_check" CHECK ("status" IN ('connected','reauth_required','disconnected')),
  CONSTRAINT "McpConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "McpConnection_userId_serverId_key" ON "McpConnection"("userId", "serverId");
CREATE TABLE "McpInvocation" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "connectionId" TEXT NOT NULL,
  "connectionVersion" INTEGER NOT NULL, "toolName" TEXT NOT NULL,
  "argumentsCiphertext" TEXT, "state" TEXT NOT NULL DEFAULT 'pending',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "McpInvocation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "McpInvocation_state_check" CHECK ("state" IN ('pending','running','completed','failed','unknown','rejected','expired')),
  CONSTRAINT "McpInvocation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "McpInvocation_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "McpConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "McpInvocation_userId_state_createdAt_idx" ON "McpInvocation"("userId", "state", "createdAt");
CREATE TABLE "McpOAuthFlow" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "serverId" TEXT NOT NULL, "policyDigest" TEXT NOT NULL,
  "connectionVersion" INTEGER, "stateHash" TEXT NOT NULL, "secretCiphertext" TEXT,
  "state" TEXT NOT NULL DEFAULT 'pending', "redirectUri" TEXT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "McpOAuthFlow_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "McpOAuthFlow_state_check" CHECK ("state" IN ('pending','running','used','failed','expired')),
  CONSTRAINT "McpOAuthFlow_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "McpOAuthFlow_stateHash_key" ON "McpOAuthFlow"("stateHash");
CREATE INDEX "McpOAuthFlow_userId_expiresAt_idx" ON "McpOAuthFlow"("userId", "expiresAt");
