import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const pagePath = fileURLToPath(new URL(
  "../app/(site)/(application)/admin/amux-backlog/page.tsx", import.meta.url));
const pageSource = readFileSync(pagePath, "utf8");
const imports = new Map([...pageSource.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g)]
  .map(match => [match[2], match[1].split(",").map(name => name.trim()).filter(Boolean)]));

async function pageFixture(role, tab) {
  const output = await build({ entryPoints: [pagePath], bundle: true,
    write: false, platform: "node", format: "esm", jsx: "automatic", plugins: [{
      name: "credential-free-page-fixture", setup(builder) {
        builder.onResolve({ filter: /^@\/lib\/amux\/ideaAnalysisClaimRecoveryCore$/ }, () => ({
          path: fileURLToPath(new URL("../lib/amux/ideaAnalysisClaimRecoveryCore.ts", import.meta.url)),
        }));
        builder.onResolve({ filter: /^(?:@\/|next|react\/jsx-runtime)/ }, args => ({
          path: args.path, namespace: "fixture",
        }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => {
          if (args.path === "react/jsx-runtime") return { contents:
            "export const Fragment = Symbol.for('fixture-fragment');" +
            "export const jsx = (type, props, key) => ({type, props, key}); export const jsxs = jsx;" };
          const bodies = {
            notFound: "throw new Error('not_found');",
            getServerSession: "return {user: {id: 'synthetic-owner'}};",
            getAdminRole: `return ${JSON.stringify(role)};`,
            getAdminMessages: "return {status: {}};",
            resolveAdminTab: `return {id: ${JSON.stringify(tab)}};`,
          };
          return { contents: (imports.get(args.path) ?? []).map(name =>
            name === "authOptions" ? "export const authOptions = {};" :
              `export function ${name}() { ${bodies[name] ?? "return false;"} }`).join("\n") };
        });
      },
    }] });
  return (await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`)).default;
}

function descendants(node) {
  if (!node || typeof node !== "object") return [];
  const children = node.props?.children;
  return [node, ...[children].flat(Infinity).flatMap(descendants)];
}

test("actual owner page renders exact hold recovery without a transfer preview", async () => {
  const previous = process.env.TOMVERSE_AMUX_V4_ANALYSIS_CLAIM_RESOLUTION_READ;
  process.env.TOMVERSE_AMUX_V4_ANALYSIS_CLAIM_RESOLUTION_READ = "enabled";
  try {
    const Page = await pageFixture("owner", "ideas");
    const id = "12345678-1234-4123-8123-123456789abc";
    const tree = await Page({ searchParams: Promise.resolve({ tab: "ideas", analysisHoldId: id }) });
    const panels = descendants(tree).filter(node => node.type?.name === "AmuxAnalysisClaimResolutionPanel");
    assert.equal(panels.length, 1);
    assert.equal(panels[0].props.holdId, id);
    assert.equal(panels[0].key, id);
    assert.equal(panels[0].props.onResolved, undefined);
    const otherTab = await pageFixture("owner", "intake");
    const hidden = await otherTab({ searchParams: Promise.resolve({ tab: "intake", analysisHoldId: id }) });
    assert.equal(descendants(hidden).filter(node => node.type?.name === "AmuxAnalysisClaimResolutionPanel").length, 0);
  } finally {
    if (previous === undefined) delete process.env.TOMVERSE_AMUX_V4_ANALYSIS_CLAIM_RESOLUTION_READ;
    else process.env.TOMVERSE_AMUX_V4_ANALYSIS_CLAIM_RESOLUTION_READ = previous;
  }
});

test("actual non-owner page refuses recovery before rendering its claim", async () => {
  const Page = await pageFixture("ops", "ideas");
  await assert.rejects(Page({ searchParams: Promise.resolve({ tab: "ideas",
    analysisHoldId: "12345678-1234-4123-8123-123456789abc" }) }), /not_found/);
});
