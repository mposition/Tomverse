/**
 * The page that runs a Python code block, and everything that confines it.
 *
 * Policy: docs/policy/generated-artifacts.md section 9, "Python 코드 블록은
 * 브라우저 안에서 실행한다".
 *
 * Python is the model's code, so it is hostile code that may compute and draw
 * and do nothing else. It gets the same isolation a previewed HTML page gets
 * (`lib/htmlArtifactPreview.ts`): a `srcdoc` frame, `sandbox="allow-scripts"`
 * and nothing more (no `allow-same-origin`, so an opaque origin with no
 * cookies, storage or DOM of the chat), and a Content-Security-Policy `<meta>`
 * as the first element of the document. This file adds a second policy rather
 * than loosening that one -- the HTML and React previews keep exactly theirs.
 *
 * What differs is where the untrusted code runs. In a preview the model's page
 * is the frame's own script. Here the frame's script is ours, fixed text that
 * runs nothing the user wrote; the Python runs in a Web Worker the frame starts
 * from a `blob:` URL, on Pyodide (CPython compiled to WebAssembly). A worker
 * has no window, no DOM and no way to navigate anything, so the
 * nested frame that exists to stop a page's script from moving the frame has
 * nothing to guard here. The worker is also what can be ended: `terminate()` on
 * a stop, a time limit or an output limit.
 *
 *   * The policy admits exactly one place on this application's origin -- the
 *     versioned `public/vendor/pyodide/<version>/` directory -- for scripts and
 *     for `connect-src`, so the runtime and its packages load and nothing else
 *     can: not `fetch`, not XHR, not `micropip` from PyPI, not a CDN.
 *     `worker-src blob:` lets the frame start its worker; the worker inherits
 *     the same policy. `'wasm-unsafe-eval'` is the one non-default script
 *     source: WebAssembly cannot be compiled without it, and it does not allow
 *     `eval` or `Function`.
 *   * The frame and the page speak only through `postMessage`, each side
 *     checking the other's window, origin, namespace and a per-frame token,
 *     and every field's kind and size (`lib/chatCodeRun.ts`). The worker is not
 *     trusted either: its messages are checked and capped by the frame before
 *     they are forwarded.
 *   * Output is data. The page shows it as text and PNG images and never as HTML.
 *
 * The files are served by this application, never a CDN: see `CODE_RUN_FILES`
 * for the pinned versions and hashes, and `next.config.ts` for the headers.
 *
 * Pure and client-safe: strings only.
 */

import { CODE_RUN_LIMITS, CODE_RUN_NAMESPACE, CODE_RUN_VERSION } from "@/lib/chatCodeRun";
import { HTML_PREVIEW_SANDBOX, previewAssetOrigin } from "@/lib/htmlArtifactPreview";

export const CODE_RUN_PYODIDE_VERSION = "314.0.8";

/** Where the runtime's files are served from (public/vendor/pyodide/<version>/). */
export const CODE_RUN_VENDOR_PATH = `/vendor/pyodide/${CODE_RUN_PYODIDE_VERSION}/`;

/** The same sandbox an HTML preview has: scripts, and nothing more. */
export const CODE_RUN_SANDBOX = HTML_PREVIEW_SANDBOX;

/**
 * Every file in the vendored directory, with its sha256 and size. Pyodide 314.0.8
 * (Python 3.14) from the npm package `pyodide` (core files) and the Pyodide
 * release's package directory (wheels, each also pinned by the sha256 in
 * `pyodide-lock.json`). `pyodide-lock.json` is the release's lock reduced to the
 * 13 packages below -- numpy, pandas, matplotlib and what they need -- so an
 * `import` of anything else is an ordinary ModuleNotFoundError rather than a
 * request for a file that is not here. A test hashes the directory against this.
 */
export const CODE_RUN_FILES: Readonly<Record<string, { sha256: string; bytes: number }>> = {
    "contourpy-1.3.3-cp314-cp314-pyemscripten_2026_0_wasm32.whl": { sha256: "0ac15ebf9f820d2d1c3526388aa2818b631cb6c4aae1682efd6b4cc12c1f302c", bytes: 118874 },
    "cycler-0.12.1-py3-none-any.whl": { sha256: "8ee450085f15b47f78b034d60059af6a3649e98fa5dde073363437742cc0b4ea", bytes: 8321 },
    "fonttools-4.62.1-py3-none-any.whl": { sha256: "0d1516e073fd0a8d8e6d9af46417b6a26209a42518024a18f7085e72d2599605", bytes: 1152647 },
    "kiwisolver-1.5.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl": { sha256: "47781998156721147c128a3c74547d5703e0e3cc454d8203e629339368308a93", bytes: 36616 },
    "matplotlib-3.10.8-cp314-cp314-pyemscripten_2026_0_wasm32.whl": { sha256: "722857932f8f62eac64f8439af15c94d427f9fb945f9590cd242805c983d2d54", bytes: 6982033 },
    "numpy-2.4.6-cp314-cp314-pyemscripten_2026_0_wasm32.whl": { sha256: "a292c1f5d7d8a2208cd5e94fc467604c131cabcd2fc14fed6eefde121e7fabdf", bytes: 2960568 },
    "packaging-26.1-py3-none-any.whl": { sha256: "565acbbea54da30348b6d68b6a54373e6f777987db9f1db6966b4b3a5060d303", bytes: 95852 },
    "pandas-3.0.2-cp314-cp314-pyemscripten_2026_0_wasm32.whl": { sha256: "45ff57772cc2f366a8582c7d3097cc4e6676342ecd5a3c08184a43462d5a02ae", bytes: 4177749 },
    "pillow-12.2.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl": { sha256: "e29838b7a756e4ee0f27a9cfa9a387ee0dfa2e9dd44be2dd595130b9f9d93ac3", bytes: 1037806 },
    "pyodide-lock.json": { sha256: "27850247710784fd04d02070d9722c6325f39c16bf6e83d87b7dbb7e6ac88ca5", bytes: 4215 },
    "pyodide.asm.mjs": { sha256: "22514b8be6980e28a02c8b1d6387ce8dfe666fc4edf8d547cff5dce29ff4d972", bytes: 1250259 },
    "pyodide.asm.wasm": { sha256: "e14d49ceca9b4a0e274ea918f3a898de2d3880b6e5573a6cfe1a2267ecc70329", bytes: 9597892 },
    "pyodide.mjs": { sha256: "1bb8cc14f9405aaa7cd4e00c12edd0a8539de9cc026618d6ee5a9663f367dc70", bytes: 17758 },
    "pyparsing-3.3.2-py3-none-any.whl": { sha256: "f0dd8225b5f8e945980b400bd465b4b90cb0498a2eede0d9dbea98372f6110c5", bytes: 122781 },
    "python_dateutil-2.9.0.post0-py2.py3-none-any.whl": { sha256: "9b13365edf9c188f570baf9c540bbb3029ada2a2dacb9694b3659941693ee9e5", bytes: 229892 },
    "python_stdlib.zip": { sha256: "2bd3394a145bfbbe5bbc9d9d6ab9136abbb986c6fef6c142b3a2962227aa5c28", bytes: 2545550 },
    "pytz-2026.1.post1-py2.py3-none-any.whl": { sha256: "b8249d6450146e0b61e6d710dc02ebb35a904796c4c2f97fe87d4ac5872db36a", bytes: 510489 },
    "six-1.17.0-py2.py3-none-any.whl": { sha256: "228c50f73aa7addf2c2ccf2979c256802a59ab69cad8152b31b9443cc8140f42", bytes: 11050 },
};

/**
 * The runner frame's policy. With this application's origin it admits the
 * versioned runtime directory for script and for `connect-src` (a `srcdoc`
 * frame's own origin is opaque, so `'self'` would not), a `blob:` worker, and
 * WebAssembly compilation. Everything else is `'none'`: images, styles, fonts,
 * media, frames, forms, plugins, `<base>`.
 */
export const codeRunCsp = (assetOrigin: string): string => {
    const origin = previewAssetOrigin(assetOrigin);
    if (!origin) throw new Error("the Python runner needs this application's origin");
    const vendor = `${origin}${CODE_RUN_VENDOR_PATH}`;
    return [
        "default-src 'none'",
        `script-src 'unsafe-inline' 'wasm-unsafe-eval' ${vendor}`,
        `connect-src ${vendor}`,
        "worker-src blob:",
        "form-action 'none'",
        "base-uri 'none'",
        "frame-src 'none'",
        "object-src 'none'",
        "manifest-src 'none'",
    ].join("; ");
};

/**
 * What the worker takes away before the person's code runs: every way it has to
 * send a request. The policy cannot do this by itself: `connect-src` admits a
 * directory on this application's origin, and a policy matches paths and never
 * query strings or bodies, so a script that could call `fetch` could still put
 * a file's text into the query of a request to that directory. With these gone
 * there is no call to make.
 *
 *   * `fetch`, `Request`, `XMLHttpRequest`, `WebSocket`, `WebSocketStream`,
 *     `EventSource`, `WebTransport`, `fetchLater`: the request makers.
 *   * `importScripts`, `Worker`, `SharedWorker`: a new worker would start with a
 *     clean `fetch`.
 *   * `caches`, `CacheStorage`, `Cache`: `Cache.add` sends a request.
 *   * `BroadcastChannel`, `FontFace`: a channel out of the worker, and a font by URL.
 *   * `sendBeacon` and `serviceWorker` on `navigator`.
 *
 * A dynamic `import(url)` cannot be removed, but it is syntax: Python can reach
 * it only by running JavaScript from a string, which the policy refuses (no
 * `'unsafe-eval'`). The worker's own variables are not globals (the script is a
 * function), so nothing of ours that calls `import()` is in reach either.
 */
export const CODE_RUN_BLOCKED_GLOBALS = [
    "fetch",
    "Request",
    "XMLHttpRequest",
    "WebSocket",
    "WebSocketStream",
    "EventSource",
    "WebTransport",
    "fetchLater",
    "importScripts",
    "Worker",
    "SharedWorker",
    "caches",
    "CacheStorage",
    "Cache",
    "BroadcastChannel",
    "FontFace",
] as const;

/** Names removed from `navigator` as well (the worker's `WorkerNavigator`). */
export const CODE_RUN_BLOCKED_NAVIGATOR = ["sendBeacon", "serviceWorker"] as const;

/**
 * The Python the worker loads once, after the runtime. Written without a
 * backslash so it is the same text in source and at run time.
 *
 * `tv_run` runs the code with Pyodide's own `eval_code_async` (top-level await
 * works, and the last expression's value comes back), keeps only the traceback
 * of the person's lines, and turns the matplotlib figures it left into PNGs.
 * Matplotlib is forced onto its non-interactive backend: there is no page to
 * draw on in a worker, and `plt.show()` does nothing.
 */
export const CODE_RUN_PYTHON_HELPER = `import base64
import io
import json
import linecache
import os
import sys
import traceback
import warnings

os.environ["MPLBACKEND"] = "AGG"

from pyodide.code import eval_code_async

SOURCE_NAME = "<code>"


def tv_namespace():
    return {"__name__": "__main__"}


def _tv_prepare(use_matplotlib):
    if use_matplotlib:
        import matplotlib

        matplotlib.use("agg")
        import matplotlib.pyplot as plt

        plt.show = lambda *args, **kwargs: None
        # Matplotlib 3.10 on Pyodide warns about its own float pixel sizes on every figure; it is not about the person's code.
        warnings.filterwarnings("ignore", message="The [xy] parameter as float was deprecated")


def _tv_figures(max_images, max_pixels, max_base64):
    pyplot = sys.modules.get("matplotlib.pyplot")
    figures = []
    skipped = 0
    if pyplot is None:
        return figures, skipped
    for number in list(pyplot.get_fignums()):
        figure = pyplot.figure(number)
        width, height = figure.get_size_inches()
        if len(figures) >= max_images or width * height * figure.dpi * figure.dpi > max_pixels:
            skipped += 1
            continue
        buffer = io.BytesIO()
        try:
            figure.savefig(buffer, format="png", bbox_inches="tight")
        except Exception:
            skipped += 1
            continue
        encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
        if len(encoded) > max_base64:
            skipped += 1
            continue
        figures.append(encoded)
    pyplot.close("all")
    return figures, skipped


def _tv_traceback(error):
    tb = error.__traceback__
    while tb is not None and tb.tb_frame.f_code.co_filename != SOURCE_NAME:
        tb = tb.tb_next
    return "".join(traceback.format_exception(type(error), error, tb))


async def tv_run(source, namespace, use_matplotlib, max_images, max_pixels, max_base64, max_text):
    status = "ok"
    value = None
    error = None
    linecache.cache[SOURCE_NAME] = (len(source), None, source.splitlines(True), SOURCE_NAME)
    try:
        _tv_prepare(use_matplotlib)
        result = await eval_code_async(source, namespace, filename=SOURCE_NAME)
        if result is not None:
            value = repr(result)[:max_text]
    except SystemExit:
        pass
    except BaseException as caught:
        status = "error"
        error = _tv_traceback(caught)[-max_text:]
    sys.stdout.flush()
    sys.stderr.flush()
    figures, skipped = _tv_figures(max_images, max_pixels, max_base64)
    return json.dumps({"status": status, "value": value, "error": error, "figures": figures, "skipped": skipped})
`;

/**
 * The worker's script. It starts the runtime, writes the person's files into the
 * current directory, loads only the packages the code imports, then removes its
 * network (`CODE_RUN_BLOCKED_GLOBALS`) and only then runs the code, and posts
 * what happened. It never touches the DOM (there is none) and can reach nothing
 * the policy above does not admit.
 *
 * A worker runs once. The network is gone for good after the first run starts,
 * so a second run -- which may need a package -- gets a fresh worker; the frame
 * starts it as soon as the last one finishes, so the runtime is already up.
 *
 * Its messages are `{ kind, runId, ... }` to the frame, which checks and
 * forwards them; Python can post to the frame too (`js.self.postMessage`), which
 * is why the frame trusts none of it. No backslashes.
 */
export const CODE_RUN_WORKER_SOURCE = `"use strict";
var used = false;
var pyodide = null;
var booting = null;
var written = [];
var current = null;

function send(message) { self.postMessage(message); }
function noop() {}

function boot() {
  if (booting) return booting;
  booting = (async function () {
    // Pyodide 314 refuses a classic worker whenever importScripts answers. A sandboxed frame has an opaque origin and
    // can only start a classic worker from a blob (a module worker from one fails), so importScripts is taken away
    // before the loader is imported: the check then passes, and the runtime is loaded with import(), which a classic worker has.
    self.importScripts = undefined;
    var loader = await import(CONFIG.base + "pyodide.mjs");
    pyodide = await loader.loadPyodide({
      indexURL: CONFIG.base,
      lockFileURL: CONFIG.base + "pyodide-lock.json",
      packageBaseUrl: CONFIG.base,
      fullStdLib: false,
      stdin: function () { return null; }
    });
    pyodide.setStdout({ write: writerFor("stdout") });
    pyodide.setStderr({ write: writerFor("stderr") });
    await pyodide.runPythonAsync(CONFIG.helper);
  })();
  return booting;
}

// Raw writes, not line batches: a prompt or a print(end="") reaches the page at once instead of waiting for a newline.
function writerFor(stream) {
  var decoder = new TextDecoder("utf-8");
  return function (bytes) {
    var text = decoder.decode(bytes, { stream: true });
    if (text && current) send({ kind: "output", runId: current, stream: stream, text: text });
    return bytes.length;
  };
}

function baseName(name) {
  var parts = String(name).split("/");
  return parts[parts.length - 1];
}

function replaceFiles(files) {
  for (var i = 0; i < written.length; i++) { try { pyodide.FS.unlink(written[i]); } catch (error) { noop(); } }
  written = [];
  for (var j = 0; j < files.length; j++) {
    var name = baseName(files[j].name);
    if (!name) continue;
    pyodide.FS.writeFile(name, new Uint8Array(files[j].data));
    written.push(name);
  }
}

// Takes away every request maker, from the global object and from every prototype above it (the members of
// WorkerGlobalScope live there), then checks that nothing callable is left under any of the names.
function removeNetwork() {
  var names = CONFIG.blocked;
  var scopes = [];
  for (var scope = self; scope; scope = Object.getPrototypeOf(scope)) scopes.push(scope);
  if (self.navigator) { for (var nav = self.navigator; nav; nav = Object.getPrototypeOf(nav)) scopes.push(nav); }
  var all = names.concat(CONFIG.blockedNavigator);
  for (var s = 0; s < scopes.length; s++) {
    for (var n = 0; n < all.length; n++) {
      var name = all[n];
      if (!Object.prototype.hasOwnProperty.call(scopes[s], name)) continue;
      try { delete scopes[s][name]; } catch (error) { noop(); }
      if (Object.prototype.hasOwnProperty.call(scopes[s], name)) {
        try { Object.defineProperty(scopes[s], name, { value: undefined, writable: false, configurable: false }); } catch (error) { noop(); }
      }
    }
  }
  // Under each name on the global object, an undefined value nobody can replace.
  for (var g = 0; g < names.length; g++) {
    try { Object.defineProperty(self, names[g], { value: undefined, writable: false, configurable: false, enumerable: false }); } catch (error) { noop(); }
  }
  var left = [];
  for (var t = 0; t < scopes.length; t++) {
    for (var m = 0; m < all.length; m++) {
      var found = false;
      try { found = Object.prototype.hasOwnProperty.call(scopes[t], all[m]) && typeof scopes[t][all[m]] !== "undefined"; } catch (error) { found = true; }
      if (found) left.push(all[m]);
    }
  }
  if (left.length) throw new Error("the sandbox could not remove: " + left.join(", "));
}

async function run(message) {
  var runId = message.runId;
  current = runId;
  try {
    send({ kind: "phase", runId: runId, phase: "runtime" });
    await boot();
    send({ kind: "phase", runId: runId, phase: "packages" });
    replaceFiles(message.files);
    await pyodide.loadPackagesFromImports(message.code, { messageCallback: noop, errorCallback: noop });
    // Everything the code may import is in. From here on this worker can send nothing anywhere.
    removeNetwork();
    send({ kind: "phase", runId: runId, phase: "running" });
    var useMatplotlib = Boolean(pyodide.loadedPackages && pyodide.loadedPackages.matplotlib);
    var namespace = pyodide.globals.get("tv_namespace")();
    var runner = pyodide.globals.get("tv_run");
    var limits = CONFIG.limits;
    var raw = await runner(message.code, namespace, useMatplotlib, limits.maxImages, limits.maxFigurePixels, limits.maxImageBase64Chars, limits.maxValueChars);
    namespace.destroy();
    runner.destroy();
    var result = JSON.parse(raw);
    send({ kind: "result", runId: runId, status: result.status, value: result.value, error: result.error, figures: result.figures, skipped: result.skipped });
  } catch (error) {
    send({ kind: "result", runId: runId, status: "error", value: null, error: String(error && error.message ? error.message : error).slice(0, 2000), figures: [], skipped: 0 });
  }
  current = null;
}

self.onmessage = function (event) {
  var message = event.data;
  if (!message) return;
  if (message.type === "boot") { boot().catch(noop); return; }
  if (message.type === "run" && !used) { used = true; run(message); }
};
`;

/**
 * The frame's own script: the half of the runner that holds the worker. Fixed
 * text -- the person's code reaches it only as data in a message, and goes
 * straight on to the worker. No backslashes.
 */
export const CODE_RUN_FRAME_SOURCE = `var NS = CONFIG.ns, VERSION = CONFIG.version, TOKEN = CONFIG.token, PARENT = CONFIG.parentOrigin, L = CONFIG.limits;
var RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
var worker = null;
var current = null;

function toParent(message) {
  message.ns = NS; message.v = VERSION; message.token = TOKEN;
  window.parent.postMessage(message, PARENT);
}

function endWorker() {
  if (worker) { worker.onmessage = null; worker.onerror = null; worker.terminate(); worker = null; }
}

function finish(status, details) {
  if (!current) return;
  var run = current;
  current = null;
  clearTimeout(run.loadTimer); clearTimeout(run.runTimer);
  // A worker is used once (its network is removed for the code), so it always ends here; after a run that finished
  // on its own, the next one is started at once so the runtime is up before the person presses Run again.
  endWorker();
  if (status === "ok" || status === "error") { try { spawn(); worker.postMessage({ type: "boot" }); } catch (error) { endWorker(); } }
  details = details || {};
  toParent({
    type: "done", runId: run.runId, status: status,
    value: details.value == null ? null : String(details.value).slice(0, L.maxValueChars),
    error: details.error == null ? null : String(details.error).slice(0, L.maxValueChars),
    skippedFigures: details.skipped || 0,
    durationMs: run.started ? Date.now() - run.started : 0
  });
}

function forwardOutput(run, stream, text) {
  var room = L.maxOutputChars - run.outputChars;
  if (room <= 0) return;
  var piece = text.length > room ? text.slice(0, room) : text;
  run.outputChars += piece.length;
  for (var i = 0; i < piece.length; i += L.maxChunkChars) {
    toParent({ type: "output", runId: run.runId, stream: stream, text: piece.slice(i, i + L.maxChunkChars) });
  }
  if (run.outputChars >= L.maxOutputChars) finish("output_limit");
}

function onWorkerMessage(event) {
  var m = event.data;
  var run = current;
  if (!run || !m || typeof m !== "object" || m.runId !== run.runId) return;
  if (m.kind === "phase" && (m.phase === "runtime" || m.phase === "packages" || m.phase === "running")) {
    toParent({ type: "phase", runId: run.runId, phase: m.phase });
    if (m.phase === "running") {
      clearTimeout(run.loadTimer);
      run.started = Date.now();
      run.runTimer = setTimeout(function () { finish("timeout"); }, L.runTimeoutMs);
    }
  } else if (m.kind === "output" && (m.stream === "stdout" || m.stream === "stderr") && typeof m.text === "string") {
    forwardOutput(run, m.stream, m.text);
  } else if (m.kind === "result") {
    var skipped = typeof m.skipped === "number" && m.skipped > 0 ? Math.floor(m.skipped) : 0;
    var figures = Array.isArray(m.figures) ? m.figures : [];
    for (var i = 0; i < figures.length; i++) {
      var encoded = figures[i];
      if (typeof encoded !== "string" || encoded.length > L.maxImageBase64Chars || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || run.images >= L.maxImages) { skipped++; continue; }
      run.images++;
      toParent({ type: "image", runId: run.runId, dataUrl: "data:image/png;base64," + encoded });
    }
    finish(m.status === "ok" ? "ok" : "error", { value: typeof m.value === "string" ? m.value : null, error: typeof m.error === "string" ? m.error : null, skipped: skipped });
  }
}

function spawn() {
  var url = URL.createObjectURL(new Blob([CONFIG.workerSource], { type: "text/javascript" }));
  worker = new Worker(url);
  setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  worker.onmessage = onWorkerMessage;
  worker.onerror = function () { finish("crashed"); };
  worker.onmessageerror = function () { finish("crashed"); };
}

function validRequest(d) {
  if (!d || typeof d !== "object" || d.ns !== NS || d.v !== VERSION || d.token !== TOKEN || d.type !== "run") return false;
  if (typeof d.runId !== "string" || !RUN_ID.test(d.runId) || typeof d.code !== "string" || d.code.length > L.maxCodeBytes) return false;
  if (!Array.isArray(d.files) || d.files.length > L.maxFiles) return false;
  var total = 0;
  for (var i = 0; i < d.files.length; i++) {
    var file = d.files[i];
    if (!file || typeof file.name !== "string" || file.name.length === 0 || file.name.length > L.maxFileNameChars || !(file.data instanceof ArrayBuffer) || file.data.byteLength > L.maxFileBytes) return false;
    total += file.data.byteLength;
  }
  return total <= L.maxTotalFileBytes;
}

window.addEventListener("message", function (event) {
  if (event.source !== window.parent || event.origin !== PARENT || !validRequest(event.data)) return;
  if (current) return;
  var d = event.data;
  current = { runId: d.runId, outputChars: 0, images: 0, started: 0, loadTimer: 0, runTimer: 0 };
  try {
    if (!worker) spawn();
  } catch (error) { finish("crashed"); return; }
  var transfer = d.files.map(function (file) { return file.data; });
  current.loadTimer = setTimeout(function () { finish("timeout"); }, L.loadTimeoutMs);
  worker.postMessage({ type: "run", runId: d.runId, code: d.code, files: d.files }, transfer);
});

toParent({ type: "ready" });
`;

/** The nonce the embedding page's own policy requires of an inline script, if it has one and it is well formed. */
const NONCE = /^[A-Za-z0-9+/_=-]{8,200}$/;

/** Makes a value safe to sit inside a `<script>` element: no `</script>`, no `<!--`. */
const scriptSafeJson = (value: unknown) =>
    JSON.stringify(value)
        .replace(/</g, "\\u003c")
        .split(String.fromCharCode(0x2028)).join("\\u2028")
        .split(String.fromCharCode(0x2029)).join("\\u2029");

/** The numbers the frame and the worker enforce, as the code above reads them. */
const frameLimits = {
    runTimeoutMs: CODE_RUN_LIMITS.runTimeoutMs,
    loadTimeoutMs: CODE_RUN_LIMITS.loadTimeoutMs,
    maxOutputChars: CODE_RUN_LIMITS.maxOutputChars,
    maxChunkChars: CODE_RUN_LIMITS.maxChunkChars,
    maxValueChars: CODE_RUN_LIMITS.maxValueChars,
    maxImages: CODE_RUN_LIMITS.maxImages,
    maxImageBase64Chars: CODE_RUN_LIMITS.maxImageBase64Chars,
    maxFigurePixels: CODE_RUN_LIMITS.maxFigurePixels,
    maxFiles: CODE_RUN_LIMITS.maxFiles,
    maxFileBytes: CODE_RUN_LIMITS.maxFileBytes,
    maxTotalFileBytes: CODE_RUN_LIMITS.maxTotalFileBytes,
    maxFileNameChars: CODE_RUN_LIMITS.maxFileNameChars,
    maxCodeBytes: CODE_RUN_LIMITS.maxCodeBytes,
};

/**
 * The runner frame's whole document. The policy `<meta>` is the first element
 * of the page. `token` is the page's name for this frame: every message either
 * way carries it, so a message meant for one frame is not taken by another.
 *
 * `assetOrigin` is this application's origin; it is also the only window the
 * frame will post to and accept from.
 */
export function buildCodeRunDocument(options: { assetOrigin: string; token: string; nonce?: string | null }): string {
    const origin = previewAssetOrigin(options.assetOrigin);
    if (!origin) throw new Error("the Python runner needs this application's origin");
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(options.token)) throw new Error("the Python runner needs a token of letters, digits, - and _");
    const base = `${origin}${CODE_RUN_VENDOR_PATH}`;
    const config = {
        ns: CODE_RUN_NAMESPACE,
        version: CODE_RUN_VERSION,
        token: options.token,
        parentOrigin: origin,
        base,
        limits: frameLimits,
        workerSource: `(function(){var CONFIG=${scriptSafeJson({ base, helper: CODE_RUN_PYTHON_HELPER, limits: frameLimits, blocked: CODE_RUN_BLOCKED_GLOBALS, blockedNavigator: CODE_RUN_BLOCKED_NAVIGATOR })};\n${CODE_RUN_WORKER_SOURCE}\n})();`,
    };
    const nonce = options.nonce && NONCE.test(options.nonce) ? ` nonce="${options.nonce}"` : "";
    return (
        `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${codeRunCsp(origin)}">` +
        `<meta charset="utf-8"></head><body>` +
        `<script${nonce}>(function(){var CONFIG=${scriptSafeJson(config)};\n${CODE_RUN_FRAME_SOURCE}})();</script></body></html>`
    );
}
