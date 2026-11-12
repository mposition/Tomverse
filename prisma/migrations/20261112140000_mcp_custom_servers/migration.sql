-- Additive: remote MCP servers a signed-in user registers by URL.
CREATE TABLE "McpCustomServer" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "name" TEXT NOT NULL, "url" TEXT NOT NULL,
  "auth" TEXT NOT NULL, "oauth" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "McpCustomServer_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "McpCustomServer_auth_check" CHECK ("auth" IN ('none','bearer','oauth')),
  CONSTRAINT "McpCustomServer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "McpCustomServer_userId_url_auth_key" ON "McpCustomServer"("userId", "url", "auth");
