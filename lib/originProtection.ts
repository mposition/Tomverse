const CANONICAL_HOST = "tomverse.app";
const CANONICAL_ORIGIN = "https://tomverse.app";
const ORIGIN_VERIFY_HEADER = "x-tomverse-origin-verify";

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

export const hasRequiredOriginSecret = (headers: Headers) => {
  if (process.env.REQUIRE_CLOUDFLARE_ORIGIN_SECRET !== "true") return true;

  const expected = process.env.CLOUDFLARE_ORIGIN_SECRET;
  const provided = headers.get(ORIGIN_VERIFY_HEADER);
  return !!(
    expected &&
    expected.length >= 32 &&
    provided &&
    safeEqual(provided, expected)
  );
};

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
