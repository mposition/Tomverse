import { createAmuxTrackedCheckoutAnalysisStreamObserver } from
  "./ideaTrackedCheckoutReadEvents.mjs";
import { awaitAmuxV19StoppableChild } from "./ideaLocalIsolatedCliRunner.mjs";

const unknown = () => ({ kind: "outcome_unknown" });

/** Attach before the child can emit output. Stderr may contain source text or
 * credentials and is always drained without retention. No stdout byte or
 * elapsed-time cap is added to the approved v19 analysis invocation. */
export function observeAmuxTrackedCheckoutChild(child, input) {
  if (!child?.stdout || typeof child.stdout.on !== "function" ||
      !child?.stderr || typeof child.stderr.resume !== "function") {
    throw new TypeError("invalid tracked checkout child");
  }
  const observer = createAmuxTrackedCheckoutAnalysisStreamObserver(input);
  let stdoutComplete = false;
  let ioFailed = false;
  let finished = false;
  child.stdout.on("data", (chunk) => observer.observeChunk(chunk));
  child.stdout.once("end", () => { stdoutComplete = true; });
  child.stdout.once("error", () => { ioFailed = true; });
  child.stderr.once("error", () => { ioFailed = true; });
  child.stderr.resume();
  return Object.freeze({
    hasIoFailure() { return ioFailed; },
    finish(exit) {
      if (finished) return unknown();
      finished = true;
      if (ioFailed || exit?.stopped || exit?.signal != null ||
          exit?.code !== 0) return unknown();
      try { return observer.finish({ exitCode: exit.code, stdoutComplete }); }
      catch { return unknown(); }
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
  const observed = observeAmuxTrackedCheckoutChild(input.child, input);
  let stdinFailed = false;
  let stdinComplete = false;
  input.child.stdin.once("error", () => { stdinFailed = true; });
  input.child.stdin.once("finish", () => { stdinComplete = true; });
  try {
    // awaitAmuxV19StoppableChild attaches error/close listeners synchronously.
    const exitPromise = awaitAmuxV19StoppableChild(input.child,
      async (signal) => stdinFailed || observed.hasIoFailure() ||
        await input.stopCheck(signal));
    input.child.stdin.end(input.prompt);
    const exit = await exitPromise;
    return stdinFailed || !stdinComplete ? unknown() : observed.finish(exit);
  } catch {
    if (typeof input.child.pid === "number" && input.child.pid > 0) {
      try { process.kill(-input.child.pid, "SIGKILL"); }
      catch {
        try { input.child.kill("SIGKILL"); } catch { /* Already closed. */ }
      }
    } else {
      try { input.child.kill("SIGKILL"); } catch { /* Already closed. */ }
    }
    return unknown();
  }
}
