export function chatRouterLocationFusionEnabled() {
  return process.env.CHAT_ROUTER_LOCATION_FUSION_ENABLED === "true" &&
    process.env.TOMVERSE_CHAT_LOCATION_INTENT_ENABLED === "true" &&
    process.env.CHAT_FRESH_LOCATION_PREPARATION_ENABLED !== "true";
}
