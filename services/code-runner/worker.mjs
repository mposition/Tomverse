// Runs one cloud job's agent with the Tomverse CLI engine (apps/tomverse-cli/src/runtime.ts), inside the job's
// sandbox. It is started by job.mjs as `node worker.mjs <request.json>`, holds no Tomverse credential, and reaches
// nothing but the model adapter's socket named in the request. Progress goes to stdout as one JSON object a line;
// the result goes to the file the request names.
//
// Approvals stand where the person would: a change to files inside the working copy and a command that runs in it
// are approved, everything else (web pages, browser, other folders) is refused. The sandbox, not this policy, is the
// boundary: commands run with no network and see only the working copy.
import { readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { isAbsolute, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const clip = (text, max = 300) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** fetch over the adapter's socket (a Unix socket, or a named pipe on Windows). The URL's host is never dialled. */
export const socketFetch = (socketPath) => (input, init = {}) => new Promise((resolveResponse, reject) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  const req = httpRequest({ socketPath, path: url.pathname + url.search, method: init.method ?? "GET", headers }, (res) => {
    const responseHeaders = new Headers();
    for (const [name, value] of Object.entries(res.headers)) if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
    const status = res.statusCode ?? 500;
    resolveResponse(new Response(status === 204 || status === 304 ? null : Readable.toWeb(res), { status, headers: responseHeaders }));
  });
  req.on("error", reject);
  if (init.signal) {
    if (init.signal.aborted) {
      req.destroy();
      reject(init.signal.reason);
      return;
    }
    init.signal.addEventListener("abort", () => req.destroy(init.signal.reason), { once: true });
  }
  if (init.body !== undefined && init.body !== null) req.write(typeof init.body === "string" ? init.body : Buffer.from(init.body));
  req.end();
});

const inside = (root, target) => {
  const fold = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
  const rel = relative(fold(resolve(root)), fold(resolve(root, target)));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

export function decide(view, root) {
  if (view.error) return { approved: false, reason: "the request was malformed" };
  if (view.patch) {
    const outside = view.patch.find((edit) => !inside(root, edit.path));
    return outside ? { approved: false, reason: "a path outside the working copy" } : { approved: true };
  }
  if (view.command) return inside(root, view.command.cwd) ? { approved: true } : { approved: false, reason: "a command outside the working copy" };
  return { approved: false, reason: "not available in a cloud task" };
}

async function loadRuntime(path) {
  if (path.endsWith(".ts")) {
    const { tsImport } = await import("tsx/esm/api");
    return tsImport(pathToFileURL(path).href, import.meta.url);
  }
  return import(pathToFileURL(path).href);
}

async function main() {
  const request = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const finish = (result) => writeFileSync(request.resultFile, JSON.stringify(result));
  const runtime = await loadRuntime(request.runtime);
  const { Gateway, Runner, createSession, Workspace, normalizeRoot, resolveEndpoint, readInstructions, resolveLimits } = runtime;
  const root = normalizeRoot(request.workDir);
  const endpoint = resolveEndpoint({ endpoint: "http://127.0.0.1/api/code/v1", allowInsecureLocalhost: true }, {});
  // The "key" only names this session to the adapter, which holds no secret either.
  const gateway = new Gateway(endpoint, "tomverse-cloud-job", socketFetch(request.socket));
  const catalog = await gateway.models();
  const model = catalog[0];
  if (!model) return finish({ outcome: "error", summary: "No model was offered." });
  const journal = createSession(null, {
    root, endpoint, keyPrefix: gateway.keyPrefix, model, readOnly: false,
    limits: resolveLimits("extended", { timeoutMs: request.timeoutMs, commandTimeoutMs: request.commandTimeoutMs }),
  });
  let lastText = "";
  const output = {
    json: true,
    info: (text) => emit({ type: "info", text: clip(String(text)) }),
    stream: () => {},
    event: (event) => {
      if (event?.type === "assistant" && typeof event.text === "string") {
        lastText = event.text;
        emit({ type: "assistant", text: clip(event.text) });
      } else if (event?.type === "tool_result") emit({ type: "tool", text: `${event.tool ?? "tool"}: ${event.status ?? "done"}` });
    },
  };
  const prompter = {
    approve: async (view) => {
      const decision = decide(view, root);
      if (view.command) emit({ type: "command", text: clip(view.command.display ?? "") });
      if (view.patch) emit({ type: "change", text: clip(view.patch.map((edit) => edit.path).join(", ")) });
      return decision.approved ? { approved: true } : { approved: false, reason: decision.reason };
    },
    confirm: async () => false,
  };
  const workspace = new Workspace(root);
  const runner = new Runner({ gateway, journal, workspace, output, prompter, catalog, commandEnv: [], instructions: readInstructions(workspace) });
  let outcome = "error";
  try {
    outcome = await runner.runTask(request.instruction);
  } catch (error) {
    emit({ type: "info", text: clip(`The agent stopped: ${String(error?.message ?? error)}`) });
  } finally {
    journal.release();
    finish({ outcome, summary: lastText.slice(0, 4000) });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  main().catch((error) => {
    // Only the message: never the environment.
    console.error(String(error?.message ?? error));
    process.exit(1);
  });
}
