export const dynamic = "force-dynamic";

import { handleOpenAiModelList } from "@/lib/externalApiModelRoutes";

// The general API's model list: the chat registry, the operator's verified
// list and the account's plan, read on every call.
export async function GET(request: Request) {
    return handleOpenAiModelList(request, "general");
}
