import assert from "node:assert/strict";
import test from "node:test";
import { allowsOAuthSubresource, classifyOAuthNavigation } from "../src/connector-oauth-policy";
import { classifyCheckoutNavigation } from "../src/billing-contract";
import { allowsSubresource, classifyLinkNavigation } from "../src/web-view-contract";
import {
  createResolvedHostGate, gatedRequestFilter, RESOLVED_HOST_ANSWER_MS, type GatedRequest, type ResolveHost,
} from "../src/host/resolved-host-gate";

/** A stand-in for the window session's resolver: every lookup is recorded; unknown names fail. */
function resolver(answers: Record<string, string[] | Error>) {
  const lookups: string[] = [];
  const resolve: ResolveHost = async (host) => {
    lookups.push(host);
    const answer = answers[host];
    if (!answer || answer instanceof Error) throw answer ?? new Error("ERR_NAME_NOT_RESOLVED");
    return { endpoints: answer.map((address) => ({ address })) };
  };
  return { resolve, lookups };
}

/** Runs one request through a filter and reports whether it was cancelled. */
function run(filter: ReturnType<typeof gatedRequestFilter>, request: GatedRequest) {
  return new Promise<boolean>((resolve) => {
    let calls = 0;
    filter(request, ({ cancel }) => {
      calls += 1;
      assert.equal(calls, 1, "the request filter answers once");
      resolve(cancel);
    });
  });
}

const answers = {
  "rebind.example.com": ["127.0.0.1"],
  "127.0.0.1.nip.io": ["127.0.0.1"],
  "metadata.example.net": ["169.254.169.254"],
  "lan.example.org": ["192.168.1.10"],
  "cgnat.example.org": ["100.64.0.5"],
  "ula.example.org": ["fd00::5"],
  "link.example.org": ["fe80::1"],
  "mapped.example.org": ["::ffff:127.0.0.1"],
  "nat64-local.example.org": ["64:ff9b:1::a00:1"],
  "mixed.example.org": ["93.184.215.14", "::1"],
  "empty.example.org": [],
  "public.example.com": ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"],
  "cdn.example.com": ["151.101.1.1"],
  "nat64.example.com": ["64:ff9b::5db8:d70e"],
};

// The link view's and the checkout window's own name rules, as the web view admits requests.
const linkAdmit = (request: GatedRequest) => request.resourceType === "mainFrame"
  ? classifyLinkNavigation(request.url) === "link" : allowsSubresource(request.url);
const checkoutAdmit = (request: GatedRequest) => request.resourceType === "mainFrame"
  ? classifyCheckoutNavigation(request.url, ["https://tomverse.app"]) === "allow" : allowsSubresource(request.url);
const oauthAdmit = (request: GatedRequest) => request.resourceType === "mainFrame"
  ? classifyOAuthNavigation(request.url, "https://tomverse.app").kind === "allow" : allowsOAuthSubresource(request.url);

test("a public name that resolves to loopback, link-local or another internal range is cancelled, main frame and subresources alike", async () => {
  const internal = ["rebind.example.com", "127.0.0.1.nip.io", "metadata.example.net", "lan.example.org", "cgnat.example.org",
    "ula.example.org", "link.example.org", "mapped.example.org", "nat64-local.example.org", "mixed.example.org"];
  for (const [label, admit] of [["link view", linkAdmit], ["checkout window", checkoutAdmit], ["sign-in window", oauthAdmit]] as const) {
    const { resolve } = resolver(answers);
    const filter = gatedRequestFilter(createResolvedHostGate(resolve), admit);
    for (const host of internal) {
      // The name rule admits these: only the resolved address refuses them.
      assert.equal(admit({ url: `https://${host}/`, resourceType: "mainFrame" }), true, `${label} ${host}`);
      assert.equal(await run(filter, { url: `https://${host}/`, resourceType: "mainFrame" }), true, `${label} main frame ${host}`);
      for (const [url, resourceType] of [[`https://${host}/app.js`, "script"], [`https://${host}/pixel.png`, "image"],
        [`https://${host}/api`, "xhr"], [`wss://${host}/socket`, "webSocket"], [`https://${host}/frame`, "subFrame"]]) {
        assert.equal(await run(filter, { url, resourceType }), true, `${label} ${resourceType} ${url}`);
      }
    }
  }
});

test("a name that does not resolve, or resolves to nothing, is refused and asked again on the next request", async () => {
  const { resolve, lookups } = resolver({ ...answers, "flaky.example.com": new Error("ERR_NAME_NOT_RESOLVED") });
  const gate = createResolvedHostGate(resolve);
  const filter = gatedRequestFilter(gate, linkAdmit);
  assert.equal(await run(filter, { url: "https://missing.example.com/", resourceType: "mainFrame" }), true);
  assert.equal(await run(filter, { url: "https://empty.example.org/", resourceType: "mainFrame" }), true);
  assert.equal(await run(filter, { url: "https://flaky.example.com/x.js", resourceType: "script" }), true);
  assert.equal(gate.kept(), 0, "a failed lookup is not kept");
  await run(filter, { url: "https://flaky.example.com/x.js", resourceType: "script" });
  assert.deepEqual(lookups.filter((host) => host === "flaky.example.com"), ["flaky.example.com", "flaky.example.com"]);
  // A resolver that throws before answering is a refusal too.
  const throwing = gatedRequestFilter(createResolvedHostGate(() => { throw new Error("session destroyed"); }), linkAdmit);
  assert.equal(await run(throwing, { url: "https://public.example.com/", resourceType: "mainFrame" }), true);
});

test("a name that resolves only to public addresses passes, including a public IPv4 host seen through NAT64", async () => {
  const { resolve } = resolver(answers);
  const filter = gatedRequestFilter(createResolvedHostGate(resolve), linkAdmit);
  assert.equal(await run(filter, { url: "https://public.example.com/page", resourceType: "mainFrame" }), false);
  assert.equal(await run(filter, { url: "https://cdn.example.com/app.js", resourceType: "script" }), false);
  assert.equal(await run(filter, { url: "wss://public.example.com/socket", resourceType: "webSocket" }), false);
  assert.equal(await run(filter, { url: "https://nat64.example.com/", resourceType: "mainFrame" }), false);
  // Inline resources need no lookup.
  assert.equal(await run(filter, { url: "data:image/png;base64,AAAA", resourceType: "image" }), false);
});

test("a request the name rule refuses is never looked up, and the gate judges an address literal without a lookup", async () => {
  const { resolve, lookups } = resolver(answers);
  const gate = createResolvedHostGate(resolve);
  const filter = gatedRequestFilter(gate, linkAdmit);
  for (const [url, resourceType] of [["http://public.example.com/", "mainFrame"], ["https://localhost/", "mainFrame"],
    ["https://127.0.0.1/", "mainFrame"], ["http://cdn.example.com/a.js", "script"], ["https://nas.local/a.js", "script"]]) {
    assert.equal(await run(filter, { url, resourceType }), true, url);
  }
  assert.deepEqual(lookups, []);
  assert.equal(await gate.allows("https://127.0.0.1/"), false);
  assert.equal(await gate.allows("https://[::ffff:169.254.169.254]/"), false);
  assert.equal(await gate.allows("https://[fd00::1]/"), false);
  assert.equal(await gate.allows("https://93.184.215.14/"), true);
  assert.equal(await gate.allows("not a url"), false);
  assert.deepEqual(lookups, []);
});

test("answers are kept per host for a short time and dropped when the window closes", async () => {
  let clock = 1_000;
  const { resolve, lookups } = resolver(answers);
  const gate = createResolvedHostGate(resolve, () => clock);
  const filter = gatedRequestFilter(gate, linkAdmit);
  // A page's burst of requests to one host, some at once: one lookup.
  await Promise.all([1, 2, 3, 4].map((index) => run(filter, { url: `https://cdn.example.com/${index}.js`, resourceType: "script" })));
  await run(filter, { url: "https://rebind.example.com/", resourceType: "mainFrame" });
  await run(filter, { url: "https://rebind.example.com/again", resourceType: "mainFrame" });
  assert.deepEqual(lookups, ["cdn.example.com", "rebind.example.com"]);
  assert.equal(gate.kept(), 2);
  // After the short lifetime the name is looked up again.
  clock += RESOLVED_HOST_ANSWER_MS;
  await run(filter, { url: "https://cdn.example.com/5.js", resourceType: "script" });
  assert.deepEqual(lookups, ["cdn.example.com", "rebind.example.com", "cdn.example.com"]);
  // Closing the window drops the answers; anything still asked afterwards is refused without a lookup.
  gate.clear();
  assert.equal(gate.kept(), 0);
  assert.equal(await run(filter, { url: "https://cdn.example.com/6.js", resourceType: "script" }), true);
  assert.equal(lookups.length, 3);
});

test("a lookup still running when the window closes ends in a refusal", async () => {
  let release: (() => void) | undefined;
  const gate = createResolvedHostGate((host) => new Promise((resolve) => {
    release = () => resolve({ endpoints: [{ address: host === "public.example.com" ? "93.184.215.14" : "127.0.0.1" }] });
  }));
  const pending = run(gatedRequestFilter(gate, linkAdmit), { url: "https://public.example.com/", resourceType: "mainFrame" });
  await new Promise((resolve) => setImmediate(resolve));
  gate.clear();
  release?.();
  assert.equal(await pending, true);
});
