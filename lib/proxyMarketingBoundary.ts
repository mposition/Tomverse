import { isApiPathname } from "@/lib/apiCacheControlPolicy";

/** API responses never inherit public marketing caching or redirects. */
export function proxyMarketingBoundary(input: Readonly<{
  pathname: string;
  method: string;
  isStatic: (pathname: string) => boolean;
  redirect: () => string | null;
}>): Readonly<{ staticMarketing: boolean; redirect: string | null }> {
  if (isApiPathname(input.pathname)) {
    return { staticMarketing: false, redirect: null };
  }
  return {
    staticMarketing: input.isStatic(input.pathname),
    redirect: input.method === "GET" || input.method === "HEAD"
      ? input.redirect() : null,
  };
}
