function routerLocationAvailable() {
  return process.env.CHAT_ROUTER_LOCATION_FUSION_ENABLED === "true" &&
    process.env.TOMVERSE_CHAT_LOCATION_INTENT_ENABLED === "true";
}

export function chatRouterLocationFusionEnabled() {
  return routerLocationAvailable() && process.env.CHAT_FRESH_LOCATION_PREPARATION_ENABLED !== "true";
}

export function existingChatRouterLocationFusionEnabled() {
  return routerLocationAvailable() && process.env.CHAT_EXISTING_ROUTER_LOCATION_FUSION_ENABLED === "true";
}
