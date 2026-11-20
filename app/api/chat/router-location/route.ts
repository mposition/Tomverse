import { POST as postChat } from "../route";
import { ROUTER_LOCATION_VERSION, ROUTER_LOCATION_VERSION_HEADER } from "@/lib/chatRouterLocationProtocol";

/** Mark handled errors as well as streams so an old deployment's missing route
 * is distinguishable from a refusal issued by Chat itself. */
export async function POST(request: Request) {
  const response = await postChat(request);
  const headers = new Headers(response.headers);
  headers.set(ROUTER_LOCATION_VERSION_HEADER, ROUTER_LOCATION_VERSION);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
