import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

import {
  hasValidMutationOrigin,
  requiresMutationOriginCheck,
} from "../lib/requestOrigin.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const ideaRoutes = path.join(root, "app", "api", "admin", "amux", "ideas");
const proxy = readFileSync(path.join(root, "proxy.ts"), "utf8");
const routes = readdirSync(ideaRoutes, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => ({ name: entry.name,
    source: readFileSync(path.join(ideaRoutes, entry.name, "route.ts"), "utf8") }));

test("every v4 idea Admin handler checks owner and recent step-up before work", () => {
  assert.ok(routes.length >= 13, "the v4 Admin route tree has moved or shrunk");
  for (const { name, source } of routes) {
    const handlers = [...source.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g)];
    assert.ok(handlers.length > 0, `${name}: no route handler found`);
    const sharedOwner = name !== "input-preview";
    if (sharedOwner) {
      const helper = source.slice(0, handlers[0].index);
      assert.match(helper, /getServerSession\(authOptions\)/, name);
      assert.match(helper, /isAdminSession\(session\)/, name);
      assert.match(helper, /getAdminRole\(session\)\s*!==\s*"owner"/, name);
      assert.match(helper, /await assertRecentAdminAuthentication\(session\)/, name);
    } else {
      assert.match(source, /isAdminSession\(session\)/, name);
    }
    for (let index = 0; index < handlers.length; index += 1) {
      const handler = source.slice(handlers[index].index,
        handlers[index + 1]?.index ?? source.length);
      const ownerAt = sharedOwner
        ? handler.indexOf("await owner()")
        : handler.indexOf("await getServerSession(authOptions)");
      const deniedAt = sharedOwner
        ? Math.max(handler.indexOf("if (session instanceof NextResponse) return session"),
          handler.indexOf('if ("response" in auth) return auth.response'))
        : handler.indexOf("getAdminRole(session) !== \"owner\"");
      const stepUpAt = sharedOwner ? deniedAt
        : handler.indexOf("await assertRecentAdminAuthentication(session)");
      const rateAt = handler.indexOf("await consumeApiRateLimit(");
      assert.ok(ownerAt >= 0 && deniedAt > ownerAt && stepUpAt >= deniedAt &&
        rateAt > stepUpAt,
      `${name} ${handlers[index][1]}: owner/step-up must precede the rate-limited work`);
      const bodyAt = handler.indexOf("await readLimitedText(");
      if (bodyAt >= 0) assert.ok(bodyAt > rateAt, `${name}: body read before authorization`);
    }
  }
});

test("v4 browser mutations keep same-origin protection; internal queue is separate", () => {
  assert.match(proxy, /requiresMutationOriginCheck\(request\.method, request\.nextUrl\.pathname\)/);
  assert.match(proxy, /!hasValidMutationOrigin\(request\)/);
  for (const { name, source } of routes) {
    if (source.includes("export async function POST")) {
      assert.equal(requiresMutationOriginCheck("POST", `/api/admin/amux/ideas/${name}`),
        true, name);
    }
  }
  const browserPath = "/api/admin/amux/ideas/submissions";
  assert.equal(hasValidMutationOrigin(new Request(`https://tomverse.app${browserPath}`, {
    method: "POST", headers: { origin: "https://other.example" },
  })), false);
  assert.equal(hasValidMutationOrigin(new Request(`https://tomverse.app${browserPath}`, {
    method: "POST", headers: { origin: "https://tomverse.app" },
  })), true);
  assert.equal(requiresMutationOriginCheck("POST", "/api/internal/amux/v4/analysis-queue"), false);
});
