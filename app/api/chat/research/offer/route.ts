import { z } from "zod";
import { consumeApiRateLimit } from "@/lib/apiSecurity";
import { researchEngineOffer } from "@/lib/researchEngineService";
import { researchNoStore, researchRouteError, researchRouteUser } from "@/lib/researchEngineRoute";

const querySchema = z.object({ profile: z.enum(["standard", "deep"]).default("standard") });

/** Availability and a deterministic estimate range. Never calls a model or a search backend. */
export async function GET(request: Request) {
  try {
    const user = await researchRouteUser(request);
    if (user.response) return user.response;
    await consumeApiRateLimit(request, user.userId, "research-engine-offer", { minute: 60, day: 2_000 });
    const query = querySchema.parse({ profile: new URL(request.url).searchParams.get("profile") ?? undefined });
    return Response.json(await researchEngineOffer(user.userId, query.profile), { headers: researchNoStore });
  } catch (error) {
    return researchRouteError(error);
  }
}
