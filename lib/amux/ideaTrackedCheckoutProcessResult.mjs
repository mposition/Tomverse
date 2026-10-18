import { createAmuxTrackedCheckoutAnalysisStreamObserver } from
  "./ideaTrackedCheckoutReadEvents.mjs";
import { awaitAmuxV19StoppableChild } from "./ideaLocalIsolatedCliRunner.mjs";

const STDERR_CLASSES = Object.freeze([
  ["authentication", /authentication_error|invalid (?:api key|oauth token)|oauth token expired|not logged in/i],
  ["rate_limit", /rate.limit|usage.limit|quota exceeded/i],
  ["model_access", /model (?:not found|unavailable)|unknown model|model_access_denied/i],
  ["network", /ECONN|ETIMEDOUT|certificate|TLS handshake|proxy error/i],
  ["permission", /permission denied|sandbox violation|restricted mode/i],
]);
const unknown = (diagnostic, failureStage, exitCode = null,
  stderrClass = null) => ({
  kind: "outcome_unknown",
  ...(diagnostic ? { failureStage,
    childExitCode: Number.isSafeInteger(exitCode) && exitCode >= 0 &&
      exitCode <= 255 ? exitCode : null,
    ...(stderrClass ? { stderrClass } : {}) } : {}),
});

/** Attach before the child can emit output. Stderr may contain source text or
 * credentials and is always drained without retention. No stdout byte or
 * elapsed-time cap is added to the approved v19 analysis invocation. */
export function observeAmuxTrackedCheckoutChild(child, input) {
  if (!child?.stdout || typeof child.stdout.on !== "function" ||
      !child?.stderr || typeof child.stderr.resume !== "function") {
    throw new TypeError("invalid tracked checkout child");
  }
  const observer = createAmuxTrackedCheckoutAnalysisStreamObserver(input);
  const diagnostic = input.diagnostic === true;
  let stdoutComplete = false;
  let ioFailed = false;
  let finished = false;
  let stderrTail = "";
  let stderrClass = null;
  child.stdout.on("data", (chunk) => observer.observeChunk(chunk));
  child.stdout.once("end", () => { stdoutComplete = true; });
  child.stdout.once("error", () => { ioFailed = true; });
  child.stderr.once("error", () => { ioFailed = true; });
  if (diagnostic) child.stderr.on("data", (chunk) => {
    if (!(chunk instanceof Uint8Array)) { ioFailed = true; return; }
    const text = stderrTail + Buffer.from(chunk).toString("utf8");
    for (const [name, pattern] of STDERR_CLASSES)
      if (pattern.test(text)) stderrClass = stderrClass && stderrClass !== name
        ? "multiple" : name;
    stderrTail = text.slice(-160);
  });
  else child.stderr.resume();
  return Object.freeze({
    hasIoFailure() { return ioFailed; },
    finish(exit, openTrace) {
      if (finished) return unknown(diagnostic, "duplicate_finish");
      finished = true;
      stderrTail = "";
      const fail = (stage, code = null) => {
        const failed = unknown(diagnostic, stage, code, stderrClass);
        if (!diagnostic) return failed;
        // Parse a final line that lacked its newline so its codes are counted.
        // The observer's verdict is discarded: this path is already unknown.
        if (stdoutComplete && stage !== "parser_rejected")
          try { observer.finish({ exitCode: null, stdoutComplete, openTrace }); }
          catch { /* Diagnostics only. */ }
        return { ...failed, cliError: observer.cliDiagnostics() };
      };
      if (ioFailed) return fail("child_io_error");
      if (exit?.stopped || exit?.timedOut || exit?.signal != null)
        return fail("child_stopped");
      if (exit?.code !== 0) return fail("child_nonzero", exit?.code);
      if (!stdoutComplete) return fail("stdout_incomplete");
      try {
        const parsed = observer.finish({ exitCode: exit.code, stdoutComplete,
          openTrace });
        if (parsed.kind !== "verified_success") return fail("parser_rejected");
        // Diagnostic (S0) runs also report how often each file tool ran.
        return diagnostic ? { ...parsed,
          toolUses: observer.cliDiagnostics().toolUses } : parsed;
      } catch { return fail("parser_rejected"); }
    },
  });
}

/** Run one already-spawned isolated child under the existing v19 stop poll.
 * The caller owns admission, sandbox verification, process-group creation,
 * provider-use accounting and cleanup. A stop or uncertain poll cannot release
 * a verified result, even if a complete JSON result reached stdout first. */
export async function awaitAmuxTrackedCheckoutChild(input) {
  if (process.platform !== "linux" || !input ||
      !Buffer.isBuffer(input.prompt) || input.prompt.length === 0 ||
      !input.child?.stdin || typeof input.child.stdin.end !== "function" ||
      typeof input.stopCheck !== "function") {
    throw new TypeError("invalid tracked checkout child invocation");
  }
  let stdinFailed = false;
  let stdinComplete = false;
  try {
    const observed = observeAmuxTrackedCheckoutChild(input.child, input);
    input.child.stdin.once("error", () => { stdinFailed = true; });
    input.child.stdin.once("finish", () => { stdinComplete = true; });
    // awaitAmuxV19StoppableChild attaches error/close listeners synchronously.
    const exitPromise = awaitAmuxV19StoppableChild(input.child,
      async (signal) => stdinFailed || observed.hasIoFailure() ||
        await input.stopCheck(signal));
    input.child.stdin.end(input.prompt);
    const exit = await exitPromise;
    const openTrace = input.finishOpenTrace
      ? await input.finishOpenTrace(exit) : undefined;
    return stdinFailed || !stdinComplete
      ? unknown(input.diagnostic === true, "stdin_incomplete")
      : observed.finish(exit, openTrace);
  } catch {
    if (typeof input.child.pid === "number" && input.child.pid > 0) {
      try { process.kill(-input.child.pid, "SIGKILL"); }
      catch {
        try { input.child.kill("SIGKILL"); } catch { /* Already closed. */ }
      }
    } else {
      try { input.child.kill("SIGKILL"); } catch { /* Already closed. */ }
    }
    return unknown(input.diagnostic === true, "child_io_error");
  }
}
