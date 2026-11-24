import { z } from "zod";
import { consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { desktopAuthNoStore, desktopAuthResponse, requireDesktopBearer } from "@/lib/desktopAuthServer";
import { externalApiAccountAccess } from "@/lib/externalApiAccess";
import { externalApiEnabled } from "@/lib/externalApiCatalogCore";
import { authenticateExternalApiKey, ExternalApiKeyError } from "@/lib/externalApiKeys";
import { mobileApiSecurityResponse } from "@/lib/mobileAuthRoute";

const schema = z.object({ key: z.string().min(1).max(160) }).strict();
const reject = () => desktopAuthResponse({ ok: false, code: "INVALID_CODE_KEY" }, 403);

export async function POST(request: Request) {
  if (request.headers.has("origin") || request.headers.has("cookie")) {
    return desktopAuthResponse({ ok: false, code: "INVALID_AUTH_CONTEXT" }, 403);
  }
  const auth = await requireDesktopBearer(request);
  if (!auth.ok) return auth.response;
  if (!externalApiEnabled(process.env)) return desktopAuthResponse({ ok: false, code: "CODE_UNAVAILABLE" }, 503);
  try {
    await consumeApiRateLimit(request, auth.identity.userId, "desktop-code-key", { minute: 15, day: 200 });
    const body = await readLimitedJson(request, 512, schema);
    const key = await authenticateExternalApiKey("Bearer " + body.key);
    if (key.userId !== auth.identity.userId) return reject();
    if (!(await externalApiAccountAccess(key.userId)).allowed) return reject();
    return desktopAuthResponse({ ok: true, keyPrefix: key.keyPrefix });
  } catch (error) {
    if (error instanceof ExternalApiKeyError) return reject();
    return desktopAuthNoStore(mobileApiSecurityResponse(error) ?? desktopAuthResponse({ ok: false, code: "KEY_CHECK_FAILED" }, 500));
  }
}
