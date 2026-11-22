import { consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { prisma } from "@/lib/prisma";
import { createResearchRun, readResearchRunDto, researchRunCreateSchema } from "@/lib/researchEngineService";
import { researchIdSchema, researchNoStore, researchRouteError, researchRouteUser } from "@/lib/researchEngineRoute";

export async function GET(request: Request) {
  try {
    const user = await researchRouteUser(request);
    if (user.response) return user.response;
    const conversationId = researchIdSchema.parse(new URL(request.url).searchParams.get("conversationId"));
    const rows = await prisma.researchPreviewRun.findMany({ where: { userId: user.userId, conversationId, engineVersion: 2 },
      select: { id: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50 });
    const runs = await Promise.all(rows.map((row) => readResearchRunDto(user.userId, row.id, request)));
    return Response.json({ runs }, { headers: researchNoStore });
  } catch (error) {
    return researchRouteError(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = await researchRouteUser(request);
    if (user.response) return user.response;
    await consumeApiRateLimit(request, user.userId, "research-engine-run-create", { minute: 10, day: 200 });
    const payload = await readLimitedJson(request, 512 * 1024, researchRunCreateSchema);
    const result = await createResearchRun({ request, userId: user.userId, payload });
    return Response.json({ run: result.run }, { status: result.created ? 201 : 200, headers: researchNoStore });
  } catch (error) {
    return researchRouteError(error);
  }
}
