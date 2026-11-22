import { consumeApiRateLimit } from "@/lib/apiSecurity";
import { deleteResearchRun, readResearchRunDto } from "@/lib/researchEngineService";
import { researchIdSchema, researchNoStore, researchRouteError, researchRouteUser } from "@/lib/researchEngineRoute";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await researchRouteUser(request);
    if (user.response) return user.response;
    const runId = researchIdSchema.parse((await params).id);
    return Response.json({ run: await readResearchRunDto(user.userId, runId, request) }, { headers: researchNoStore });
  } catch (error) {
    return researchRouteError(error);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await researchRouteUser(request);
    if (user.response) return user.response;
    await consumeApiRateLimit(request, user.userId, "research-engine-run-delete", { minute: 20, day: 500 });
    const runId = researchIdSchema.parse((await params).id);
    return Response.json(await deleteResearchRun({ request, userId: user.userId, runId }), { headers: researchNoStore });
  } catch (error) {
    return researchRouteError(error);
  }
}
