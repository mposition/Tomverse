import { isInternalAddress, isIpAddress } from "../internal-address";

/** The window session's own resolver (Electron `session.resolveHost`), or a stand-in in tests. */
export type ResolveHost = (host: string) => Promise<{ endpoints: readonly { address: string }[] }>;
export type GatedRequest = { url: string; resourceType: string };
export type GateResponse = { cancel: boolean };

type Answer = "public" | "internal" | "failed";

/** How long one host's answer is reused: a page's burst of requests, not a DNS lifetime. */
export const RESOLVED_HOST_ANSWER_MS = 10_000;

/**
 * The address check behind the request filter of the in-app web views (checkout, connector
 * sign-in, documentation and links). A request passes only when every address its host name
 * resolves to, through the window's own session, is public; a failed or empty answer is a
 * refusal. Answers are kept per host for a few seconds and dropped when the window closes.
 *
 * What it cannot do: the connection Chromium then opens looks the name up again, and nothing here
 * pins it to the address that was checked. A name whose answer changes between this check and the
 * connection (DNS rebinding) can still be connected to an internal address. These windows load
 * https only and keep certificate verification on, so such a page cannot read a local service's
 * response under the attacker's name, but the connection attempt itself is not prevented.
 */
export function createResolvedHostGate(resolve: ResolveHost, now: () => number = Date.now) {
  const answers = new Map<string, { at: number; answer: Promise<Answer> }>();
  let closed = false;

  function answerFor(host: string): Promise<Answer> {
    const known = answers.get(host);
    if (known && now() - known.at < RESOLVED_HOST_ANSWER_MS) return known.answer;
    const answer = Promise.resolve().then(() => resolve(host)).then((resolved): Answer => {
      const endpoints = Array.isArray(resolved?.endpoints) ? resolved.endpoints : [];
      if (!endpoints.length) return "failed";
      return endpoints.some(({ address }) => isInternalAddress(String(address))) ? "internal" : "public";
    }, (): Answer => "failed");
    const entry = { at: now(), answer };
    answers.set(host, entry);
    // A failed lookup is not kept: the next request asks again.
    void answer.then((value) => { if (value === "failed" && answers.get(host) === entry) answers.delete(host); });
    return answer;
  }

  return {
    /** Whether the request may go out. Inline data needs no lookup; an IP literal is judged as it is. */
    async allows(url: string): Promise<boolean> {
      if (closed) return false;
      let target: URL;
      try { target = new URL(url); } catch { return false; }
      if (target.protocol === "data:" || target.protocol === "blob:") return true;
      // The name is looked up as the connection will see it, trailing dot included.
      const host = target.hostname.toLowerCase();
      const literal = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
      if (!literal) return false;
      if (isIpAddress(literal)) return !isInternalAddress(literal);
      const answer = await answerFor(literal);
      return !closed && answer === "public";
    },
    /** Called when the window closes: every kept answer is dropped and later requests are refused. */
    clear() {
      closed = true;
      answers.clear();
    },
    /** Hosts with a kept answer; for tests. */
    kept: () => answers.size,
  };
}

export type ResolvedHostGate = ReturnType<typeof createResolvedHostGate>;

/**
 * A session `webRequest.onBeforeRequest` listener. `admit` is the window's own rule for the URL
 * (its scheme and name); an admitted request, main-frame navigation or subresource alike, then
 * waits for the address check and is cancelled unless it passes.
 */
export function gatedRequestFilter(gate: ResolvedHostGate, admit: (request: GatedRequest) => boolean) {
  return (request: GatedRequest, callback: (response: GateResponse) => void) => {
    if (!admit(request)) return callback({ cancel: true });
    void gate.allows(request.url).then((allowed) => callback({ cancel: !allowed }), () => callback({ cancel: true }));
  };
}
