/**
 * Whether an IP address is one a page in an in-app web view must not be sent to: loopback,
 * private, link-local, CGNAT, unique-local, multicast, documentation and other ranges that are
 * not public unicast. Pure and dependency-free; the host applies it to the addresses a request's
 * host name resolves to (see `host/resolved-host-gate.ts`).
 */

function parseIpv4(text: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

/** Eight 16-bit groups, or null. A trailing dotted quad is read as the last two groups. */
function parseIpv6(text: string): number[] | null {
  let value = text;
  const lastColon = value.lastIndexOf(":");
  if (lastColon < 0) return null;
  const tail = value.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIpv4(tail);
    if (!v4) return null;
    value = value.slice(0, lastColon + 1) + ((v4[0] << 8) | v4[1]).toString(16) + ":" + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const groupsOf = (part: string) => part === "" ? [] : part.split(":");
  const head = groupsOf(halves[0]);
  const rest = halves.length === 2 ? groupsOf(halves[1]) : [];
  if (halves.length === 2 && head.length + rest.length > 7) return null;
  const text8 = halves.length === 2 ? [...head, ...Array<string>(8 - head.length - rest.length).fill("0"), ...rest] : head;
  if (text8.length !== 8 || !text8.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
  return text8.map((group) => parseInt(group, 16));
}

function internalIpv4([a, b, c]: number[]): boolean {
  return a === 0 || a === 10 || a === 127 || a >= 224 || // this network, private, loopback, multicast and reserved
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64.0.0/10
    (a === 169 && b === 254) || // link-local, including cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF assignments, TEST-NET-1
    (a === 192 && b === 88 && c === 99) || // 6to4 relay anycast
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113); // TEST-NET-3
}

function internalIpv6(g: number[]): boolean {
  const embedded = (high: number, low: number) => internalIpv4([high >> 8, high & 0xff, low >> 8, low & 0xff]);
  const zero = (from: number, to: number) => g.slice(from, to).every((group) => group === 0);
  // ::/96: unspecified, loopback and the old IPv4-compatible form.
  if (zero(0, 6)) return true;
  // ::ffff:0:0/96 IPv4-mapped and ::ffff:0:0:0/96 IPv4-translated: the IPv4 address decides.
  if (zero(0, 5) && g[5] === 0xffff) return embedded(g[6], g[7]);
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return embedded(g[6], g[7]);
  // 64:ff9b::/96, the NAT64 well-known prefix: a public IPv4 host seen through DNS64 stays reachable.
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return embedded(g[6], g[7]);
  // 64:ff9b:1::/48, the local-use NAT64 prefix (RFC 8215), is never global.
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true;
  // 2002::/16 6to4: the IPv4 address in bits 16-47 decides.
  if (g[0] === 0x2002) return embedded(g[1], g[2]);
  // 2001::/32 Teredo: the client address is obfuscated and no public site is served from it.
  if (g[0] === 0x2001 && g[1] === 0) return true;
  // 2001:db8::/32 documentation, 2001:2::/48 benchmarking, 3fff::/20 documentation.
  if (g[0] === 0x2001 && (g[1] === 0xdb8 || (g[1] === 2 && g[2] === 0))) return true;
  if (g[0] === 0x3fff && g[1] < 0x1000) return true;
  // Only global unicast 2000::/3 is public: unique-local fc00::/7, link-local fe80::/10, site-local
  // fec0::/10, multicast ff00::/8, discard 100::/64 and the reserved space all fall outside it.
  return (g[0] & 0xe000) !== 0x2000;
}

/** An IPv4 or IPv6 address literal (IPv6 without brackets). */
export function isIpAddress(text: string): boolean {
  const value = text.trim().toLowerCase();
  return parseIpv4(value) !== null || value.includes("%") || parseIpv6(value) !== null;
}

/** True unless the address is public unicast. Anything that does not read as an address is internal. */
export function isInternalAddress(address: string): boolean {
  const value = address.trim().toLowerCase();
  const v4 = parseIpv4(value);
  if (v4) return internalIpv4(v4);
  // A zone index names a local interface.
  if (value.includes("%")) return true;
  const v6 = parseIpv6(value);
  return v6 ? internalIpv6(v6) : true;
}
