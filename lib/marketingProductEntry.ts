import { CHAT_WORKSPACE_PATH, PRODUCT_SURFACE_PATH } from "@/lib/productSurfaceRoutes";

/** Keep workspace imports out of marketingRoutes, which is also an auth dependency. */
export const marketingProductEntryHref = (
  product: "chat" | "review",
  lang: string,
) => {
  const path = product === "chat" ? CHAT_WORKSPACE_PATH : PRODUCT_SURFACE_PATH.review;
  return `${path}?lang=${encodeURIComponent(lang)}`;
};
