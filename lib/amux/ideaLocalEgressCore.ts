import { isIP } from "node:net";

/** Necessary, not sufficient, for an AMUX v4 CLI egress tunnel. The caller
 * must obtain its exact host list from a versioned owner-approved catalog,
 * resolve DNS outside the sandbox, and connect to the returned IP directly.
 * No host is allowed by default and this never grants a live model call. */
export type AmuxV4EgressDecision =
  | { decision: "connect_candidate"; host: string; address: string; port: 443 }
  | { decision: "hold"; reason: "config_invalid" | "target_refused" |
      "dns_unavailable" | "address_refused" };
export type AmuxV4EgressTarget =
  | { decision: "target_approved"; host: string }
  | { decision: "hold"; reason: "config_invalid" | "target_refused" };

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const AUTHORITY = /^([a-z0-9.-]{1,253}):443$/;
const RESERVED_IPV4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
  ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

const ipv4Number = (address: string): number =>
  address.split(".").reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0);

export function isPublicAmuxV4Ipv4(address: unknown): address is string {
  if (typeof address !== "string" || isIP(address) !== 4 ||
      !/^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(address)) {
    return false;
  }
  const value = ipv4Number(address);
  return !RESERVED_IPV4.some(([base, prefix]) => {
    const mask = (0xffffffff << (32 - prefix)) >>> 0;
    return (value & mask) === (ipv4Number(base) & mask);
  });
}

const validHost = (host: unknown): host is string =>
  typeof host === "string" && host.length <= 253 && host.includes(".") &&
  isIP(host) === 0 && host.split(".").every((label) => LABEL.test(label));

export function planAmuxV4EgressTarget(input: {
  method: unknown;
  authority: unknown;
  approvedHosts: unknown;
}): AmuxV4EgressTarget {
  if (!Array.isArray(input.approvedHosts) || input.approvedHosts.length < 1 ||
      input.approvedHosts.length > 16 ||
      !input.approvedHosts.every(validHost) ||
      new Set(input.approvedHosts).size !== input.approvedHosts.length) {
    return { decision: "hold", reason: "config_invalid" };
  }
  if (input.method !== "CONNECT" || typeof input.authority !== "string") {
    return { decision: "hold", reason: "target_refused" };
  }
  const match = AUTHORITY.exec(input.authority);
  const host = match?.[1];
  if (!validHost(host) || !input.approvedHosts.includes(host)) {
    return { decision: "hold", reason: "target_refused" };
  }
  return { decision: "target_approved", host };
}

export function planAmuxV4EgressConnect(input: {
  method: unknown;
  authority: unknown;
  approvedHosts: unknown;
  resolvedAddresses: unknown;
}): AmuxV4EgressDecision {
  const target = planAmuxV4EgressTarget(input);
  if (target.decision === "hold") return target;
  if (!Array.isArray(input.resolvedAddresses) || input.resolvedAddresses.length < 1 ||
      input.resolvedAddresses.length > 16) {
    return { decision: "hold", reason: "dns_unavailable" };
  }
  if (!input.resolvedAddresses.every(isPublicAmuxV4Ipv4)) {
    return { decision: "hold", reason: "address_refused" };
  }
  return { decision: "connect_candidate", host: target.host,
    address: input.resolvedAddresses[0], port: 443 };
}
