import { resolveChatRouteSession } from "@/lib/chatRouteSession";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { conversationLockedResponse } from "@/lib/conversationLock";
import { GeneratedArtifactLineageError, readGeneratedArtifactVersions } from "@/lib/generatedArtifactLineage";

export async function GET(request: Request, context: { params: Promise<{ artifactId: string }> }) {
  try {
    const auth = await resolveChatRouteSession(request);
    if (auth.response) return auth.response;
    const userId = auth.session?.user?.id;
    if (!userId) return Response.json({ error: "Login required" }, { status: 401 });
    await consumeApiRateLimit(request, userId, "artifact-versions", { minute: 30, day: 500 });
    const { artifactId } = await context.params;
    const result = await readGeneratedArtifactVersions({ request, userId, artifactId,
      cursor: new URL(request.url).searchParams.get("cursor") });
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (security) return security;
    if (error instanceof GeneratedArtifactLineageError) {
      if (error.code === "CONVERSATION_LOCKED") return conversationLockedResponse();
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    console.error(JSON.stringify({ event: "generated_artifact_versions_failed", name: error instanceof Error ? error.name : "UnknownError" }));
    return Response.json({ error: "Could not load file versions." }, { status: 500 });
  }
}
