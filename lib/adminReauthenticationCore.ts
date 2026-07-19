const FALLBACK_ADMIN_PATH = "/admin/overview";
const PUBLIC_ORIGIN = "https://tomverse.app";

export const normalizeAdminCallbackPath = (value: unknown) => {
  if (typeof value !== "string" || !value.trim()) {
    return FALLBACK_ADMIN_PATH;
  }

  try {
    const parsed = new URL(value, PUBLIC_ORIGIN);
    if (
      parsed.origin !== PUBLIC_ORIGIN ||
      (parsed.pathname !== "/admin" && !parsed.pathname.startsWith("/admin/"))
    ) {
      return FALLBACK_ADMIN_PATH;
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return FALLBACK_ADMIN_PATH;
  }
};

export const adminReauthenticationHref = (callbackPath: unknown) => {
  const url = new URL("/auth/admin-reauthenticate", PUBLIC_ORIGIN);
  url.searchParams.set("callbackUrl", normalizeAdminCallbackPath(callbackPath));
  return `${url.pathname}${url.search}`;
};
