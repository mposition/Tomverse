/** Browser regression for the actual office and monitor components. The local
 * fixture supplies telemetry only; no application authentication is bypassed.
 * No product server, database, worker send or provider call is involved. */
import { build } from "esbuild";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = await mkdtemp(join(tmpdir(), "tomverse-office-cli-ui-"));
await build({ entryPoints: { ui: resolve(root, "tests/agentOfficeCliMonitor/fixture.tsx") }, outdir: resolve(dir, "dist"), bundle: true,
  format: "esm", platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' },
  plugins: [{ name: "next-browser-test-adapter", setup(b) {
    b.onResolve({ filter: /^next\/(navigation|link)$/ }, a => ({ path: a.path, namespace: "test-next" }));
    b.onLoad({ filter: /.*/, namespace: "test-next" }, a => ({ loader: "jsx", contents: a.path.endsWith("link")
      ? 'import React from "react";export default function Link({href,children,scroll,prefetch,...p}){return <a href={href} {...p}>{children}</a>}'
      : 'export const usePathname=()=>"/admin/office"; export const useRouter=()=>({push(){},refresh(){},replace(){}});', resolveDir: root }));
  } }], logLevel: "error" });
const fixture = { state: "live", receivedAt: new Date().toISOString(), snapshot: {
  worker: "codex-impl", source: "amux-codex-rollout", capturedAt: new Date().toISOString(), truncated: false,
  events: [{kind:"prompt",text:"Inspect the office reconnect behavior."},
    {kind:"assistant",text:"I will inspect the existing tests."},
    {kind:"tool",text:"exec_command\nnpm test"}, {kind:"output",text:"24 passed\n<script>window.untrustedExecuted=true</script>"}],
  rawOutput: "$ npm test\n24 passed\nWaiting for the next task",
} };
let reads = 0, forbidden = 0, mode = "live";
const server = createServer(async (req,res) => {
  if (req.url.startsWith("/api/admin/office/cli-monitor")) {
    if (req.method !== "GET") forbidden++;
    reads++;
    res.setHeader("Content-Type", "application/json");
    if (mode === "reauth") {res.statusCode=428;res.end(JSON.stringify({error:"ADMIN_REAUTHENTICATION_REQUIRED"}));}
    else if(mode === "unavailable") res.end(JSON.stringify({state:"unavailable",receivedAt:null,snapshot:null}));
    else res.end(JSON.stringify({...fixture,state:mode}));
    return;
  }
  if(req.url==="/ui.js"||req.url==="/ui.css") {
    const asset = req.url === "/ui.css" ? "ui.css" : "ui.js";
    res.setHeader("Content-Type", asset === "ui.css" ? "text/css" : "text/javascript");
    res.end(await readFile(resolve(dir,"dist",asset))); return;
  }
  res.setHeader("Content-Type","text/html");
  res.end('<!doctype html><html class="light"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/ui.css"><style>*{box-sizing:border-box}body{margin:0;--font-ui:Arial,sans-serif;--font-code:monospace}button,input,select{font:inherit}</style></head><body><div id="root"></div><script type="module" src="/ui.js"></script></body></html>');
});
await new Promise(r=>server.listen(0,"127.0.0.1",r));
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1600,height:1050}});
const errors=[];page.on("pageerror",e=>errors.push(e.message));
const open=async()=>{
  const person=page.getByTestId("agent-office-amux-person").filter({hasText:"codex-impl"});
  await person.focus();await person.press("Enter");await page.getByTestId("agent-office-view-cli").click();
  await page.getByTestId("agent-office-cli-monitor").getByText("Inspect the office reconnect behavior.",{exact:true}).waitFor();
};
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await open();
  const monitor=page.getByTestId("agent-office-cli-monitor");
  assert.equal(await monitor.locator("textarea").count(),0);
  assert.equal(await monitor.locator('input:not([type="search"])').count(),0);
  assert.equal(await page.evaluate(()=>window.untrustedExecuted),undefined);
  await monitor.getByRole("searchbox").fill("24 passed");
  assert.equal(await monitor.getByText("I will inspect the existing tests.",{exact:true}).count(),0);
  await monitor.getByRole("searchbox").fill("");
  await monitor.getByRole("tab",{name:"Raw output",exact:true}).click();
  await monitor.getByText("$ npm test\n24 passed\nWaiting for the next task",{exact:true}).waitFor();
  await monitor.getByRole("tab",{name:"Transcript",exact:true}).click();
  await monitor.getByRole("button",{name:"Pause updates",exact:true}).click();
  const before=reads;await page.waitForTimeout(5_500);assert.equal(reads,before);
  await monitor.getByRole("button",{name:"Resume updates",exact:true}).click();
  await page.waitForTimeout(250);assert.ok(reads>before);
  await page.screenshot({path:resolve(dir,"desktop-light.png"),fullPage:true});
  await monitor.getByRole("button",{name:"Expand monitor",exact:true}).click();
  assert.equal(await monitor.getAttribute("aria-modal"),"true");
  await page.keyboard.press("Escape");
  assert.equal(await monitor.getAttribute("role"),"region");
  await monitor.getByRole("button",{name:"Expand monitor",exact:true}).click();
  await page.mouse.click(3,3);
  assert.equal(await monitor.getAttribute("role"),"region");
  await monitor.getByRole("button",{name:"Close CLI monitor",exact:true}).click();
  await open();
  mode="stale";await page.waitForTimeout(5_200);await monitor.getByText("Reconnecting",{exact:true}).first().waitFor();
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>document.documentElement.className="dark");
  await page.waitForTimeout(100);
  assert.equal(await monitor.getAttribute("aria-modal"),"true");
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  await page.screenshot({path:resolve(dir,"mobile-dark.png"),fullPage:false});
  mode="reauth";await page.waitForTimeout(5_200);
  await monitor.getByTestId("admin-api-reauthenticate-link").waitFor();
  await monitor.getByText("Sign-in required",{exact:true}).first().waitFor();
  assert.equal(await monitor.getByText("Reconnecting",{exact:true}).count(),0);
  assert.equal(await monitor.getByText("Inspect the office reconnect behavior.",{exact:true}).count(),0);
  assert.equal(forbidden,0);assert.deepEqual(errors,[]);
  await writeFile(resolve(dir,"result.json"),JSON.stringify({pass:true,reads,forbidden,checks:["office entry","read only","search","raw output","pause/resume","expand/Escape","stale connection","mobile overflow","reauth clears content","untrusted text escaped"]},null,2));
  console.log(JSON.stringify({pass:true,reads,forbidden,checks:10,artifacts:dir}));
}finally{await browser.close();await new Promise(r=>server.close(r));}
