const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const EXEMPT_MUTATION_PATHS = [
  "/api/auth/",
  "/api/billing/webhook",
  "/api/internal/",
  "/api/security/csp-report",
];

const normalizeOrigin = (value: string | null) => {
  if (!value) return null;
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return null;
  }
};

export const requiresMutationOriginCheck = (method: string, pathname: string) =>
  !SAFE_METHODS.has(method.toUpperCase()) &&
  !EXEMPT_MUTATION_PATHS.some((path) =>
    path.endsWith("/") ? pathname.startsWith(path) : pathname === path
  );

export const hasValidMutationOrigin = (request: Request) => {
  const expected = normalizeOrigin(request.url);
  const provided = normalizeOrigin(request.headers.get("origin"));
  if (expected && provided) return expected === provided;

  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (!provided && fetchSite === "same-origin") return true;

  const referer = normalizeOrigin(request.headers.get("referer"));
  return Boolean(expected && referer && expected === referer);
};
