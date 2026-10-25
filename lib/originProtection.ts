const CANONICAL_HOST = "tomverse.app";
const CANONICAL_ORIGIN = "https://tomverse.app";
const ORIGIN_VERIFY_HEADER = "x-tomverse-origin-verify";

/** Exact HTTPS origin used by mobile login configuration, without a path or credentials. */
export const mobileAuthHttpsOrigin = (value: string): string | null => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      url.pathname === "/" && !url.search && !url.hash ? url.origin : null;
  } catch { return null; }
};

/** The browser return host must remain separate from every configured login host. */
export const mobileAppLinkOrigin = (env: NodeJS.ProcessEnv = process.env) => {
  const origin = mobileAuthHttpsOrigin(env.MOBILE_AUTH_APP_LINK_ORIGIN ?? "");
  const loginOrigins = ["https://tomverse.app", "https://www.tomverse.app", env.NEXTAUTH_URL,
    env.PUBLIC_APP_URL, env.NEXT_PUBLIC_APP_URL, env.NEXT_PUBLIC_SHARE_BASE_URL]
    .filter((value): value is string => Boolean(value)).map(mobileAuthHttpsOrigin);
  return origin && !loginOrigins.includes(origin) ? origin : null;
};

const splitCsv = (value: string | undefined) =>
  (value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

const hostFromOrigin = (value: string | undefined) => {
  if (!value) return null;
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
};

const originFromValue = (value: string | undefined) => {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      isLocalHost(url.host.toLowerCase())
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
};

const isLocalHost = (host: string) =>
  host === "localhost" ||
  host.endsWith(".localhost") ||
  host.startsWith("localhost:") ||
  host === "127.0.0.1" ||
  host.startsWith("127.0.0.1:") ||
  host === "[::1]" ||
  host.startsWith("[::1]:");

export type AmuxReviewProxyEnvironment = {
  [key: string]: string | undefined;
  TOMVERSE_AMUX_REVIEW_INTERNAL_ORIGIN?: string;
  RAILWAY_PRIVATE_DOMAIN?: string;
  PORT?: string;
};

const railwayPrivateDomain = (value: string | undefined) => {
  const hostname = value?.trim().toLowerCase() ?? "";
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.railway\.internal$/.test(hostname))
    return null;
  return hostname;
};

/**
 * The optional review proxy carries an administrator cookie and the AMUX sync
 * credential, so its target is narrower than the application's normal host
 * allowlist: it must be this process's IPv4 loopback or this exact Railway
 * service, on the process's explicit listener port. Sibling services are not
 * part of the trust boundary.
 */
export const amuxReviewPrivateProxyOrigin = (
  env: AmuxReviewProxyEnvironment,
): string | null => {
  const raw = env.TOMVERSE_AMUX_REVIEW_INTERNAL_ORIGIN?.trim();
  if (!raw) return null;

  const expectedHostname = railwayPrivateDomain(env.RAILWAY_PRIVATE_DOMAIN);
  const expectedPort = env.PORT?.trim() ?? "";
  if (!/^\d{1,5}$/.test(expectedPort)) return null;
  const portNumber = Number(expectedPort);
  if (portNumber < 1 || portNumber > 65_535) return null;

  try {
    const url = new URL(raw);
    const loopback = url.hostname === "127.0.0.1";
    const sameRailwayService = Boolean(
      expectedHostname && url.hostname.toLowerCase() === expectedHostname,
    );
    if (
      !["http:", "https:"].includes(url.protocol) ||
      (!loopback && !sameRailwayService) ||
      (loopback && url.protocol !== "http:") ||
      url.port !== expectedPort ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) return null;
    return url.origin;
  } catch {
    return null;
  }
};

export const isAllowedAmuxReviewPrivateHost = (hostHeader: string | null) => {
  const origin = amuxReviewPrivateProxyOrigin(process.env);
  const host = hostHeader?.trim().toLowerCase();
  return Boolean(origin && host && new URL(origin).host.toLowerCase() === host);
};

export const getAllowedRequestHosts = () => {
  const hosts = new Set<string>([CANONICAL_HOST]);
  for (const origin of [
    process.env.PUBLIC_APP_URL,
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.NEXT_PUBLIC_SHARE_BASE_URL,
    process.env.NEXTAUTH_URL,
  ]) {
    const host = hostFromOrigin(origin);
    if (host && !isLocalHost(host)) hosts.add(host);
  }
  for (const host of splitCsv(process.env.ALLOWED_REQUEST_HOSTS)) {
    hosts.add(host);
  }
  return hosts;
};

export const isAllowedRequestHost = (hostHeader: string | null) => {
  const host = hostHeader?.trim().toLowerCase();
  if (!host) return false;
  if (process.env.NODE_ENV !== "production" && isLocalHost(host)) return true;
  return getAllowedRequestHosts().has(host);
};

const safeEqual = (left: string, right: string) => {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
};

export const hasValidOriginSecret = (headers: Headers) => {
  const expected = process.env.CLOUDFLARE_ORIGIN_SECRET;
  const provided = headers.get(ORIGIN_VERIFY_HEADER);
  return !!(
    expected &&
    expected.length >= 32 &&
    provided &&
    safeEqual(provided, expected)
  );
};

export const hasRequiredOriginSecret = (headers: Headers) =>
  process.env.REQUIRE_CLOUDFLARE_ORIGIN_SECRET !== "true" ||
  hasValidOriginSecret(headers);

export const getPublicReportOrigin = () => {
  for (const value of [
    process.env.NEXT_PUBLIC_SHARE_BASE_URL,
    process.env.PUBLIC_APP_URL,
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.NEXTAUTH_URL,
  ]) {
    const origin = originFromValue(value);
    if (origin) return origin;
  }

  return CANONICAL_ORIGIN;
};
