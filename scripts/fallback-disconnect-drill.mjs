// Hangs up on purpose while a fallback is streaming.
//
//   node scripts/fallback-disconnect-drill.mjs \
//       --url https://<staging>/api/chat \
//       --secret "$ROUTING_FAULT_INJECTION_SECRET" \
//       --cookie "<the drill account's session>" \
//       --conversation <auto conversation id>
//
// Step 5 of docs/ops/tomverse-chat-auto-router-rollout.md §9.1. The other
// drill cases are produced by injecting a provider fault; this one cannot be,
// because the thing under test is what happens when the *client* goes away
// mid-retry, and no provider-side fault reproduces that.
//
// ## Why the abort point is exact rather than a race
//
// §7 sends `retrying_with_another_model` before the next model's first token,
// and the signal is a NUL-led chunk providers cannot emit. So on a fallback
// turn the marker is the first thing on the wire, always, and "abort as soon
// as the marker arrives" lands squarely between the fallback being dispatched
// and its first token. A timer would sometimes disconnect before the fallback
// existed and sometimes after it finished, and a drill that tests a different
// thing each run is not a drill.
//
// Prints the traceId. Feed it to `npm run drill:fallback-verify -- --scenario
// disconnect_during_fallback`.

const argument = (name) => {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? undefined : process.argv[index + 1];
};

const url = argument("url");
const secret = argument("secret");
const cookie = argument("cookie");
const conversationId = argument("conversation");
const prompt = argument("prompt") ?? "Explain what a context window is.";

if (!url || !secret || !cookie || !conversationId) {
    console.error(
        "Usage: node scripts/fallback-disconnect-drill.mjs --url <chat endpoint> " +
            "--secret <ROUTING_FAULT_INJECTION_SECRET> --cookie <session cookie> " +
            "--conversation <auto conversation id> [--prompt <text>]\n\n" +
            "Staging only. The endpoint refuses to inject anything in production " +
            "and without the secret it refuses to inject at all."
    );
    process.exit(2);
}

// The marker lib/routingRetrySignal.ts writes. Duplicated as a literal rather
// than imported because this script runs against a *deployed* server and has
// to agree with what that server sends, not with this checkout — and a drill
// that silently agreed with itself would pass while the wire format had moved.
const RETRY_MARKER = `${String.fromCharCode(0)}TOMVERSE_ROUTING_RETRY`;

const controller = new AbortController();
let traceId = null;
let sawMarker = false;

try {
    const response = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: {
            "Content-Type": "application/json",
            Cookie: cookie,
            // The primary fails before a token, which is what gets the turn as
            // far as a fallback to disconnect during.
            "X-Tomverse-Fault-Injection": `${secret}:attempt_0_pre_token`,
        },
        body: JSON.stringify({
            conversationId,
            messages: [{ role: "user", content: prompt }],
        }),
    });

    traceId = response.headers.get("x-request-id");
    if (!response.ok) {
        console.error(`The request failed with HTTP ${response.status}.`);
        console.error(await response.text().catch(() => ""));
        process.exit(1);
    }
    if (!response.body) {
        console.error("The response carried no body to disconnect from.");
        process.exit(1);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        seen += decoder.decode(value, { stream: true });
        if (seen.includes(RETRY_MARKER)) {
            sawMarker = true;
            // Here, and not a byte later. The fallback has been dispatched and
            // has not yet delivered anything.
            controller.abort();
            break;
        }
        if (seen.length > 4096) {
            // Answer text arrived without a marker, so no fallback happened and
            // there is nothing to disconnect during. Stopping here rather than
            // aborting anyway keeps a non-drill from being filed as one.
            break;
        }
    }
} catch (error) {
    // An abort we asked for is the drill working, not a failure.
    if (error?.name !== "AbortError") {
        console.error("The drill request failed:", error);
        process.exit(1);
    }
}

if (!traceId) {
    console.error("No X-Request-ID came back, so the run cannot be verified.");
    process.exit(1);
}

if (!sawMarker) {
    console.error(
        `traceId ${traceId}\n\n` +
            "No retry signal arrived, so no fallback happened and this run is " +
            "not the disconnect case. Check that the fault injector is armed " +
            "(chat_fault_injection_armed in the logs), that " +
            "AUTO_ROUTER_FALLBACK_ENABLED is on, and that the conversation is " +
            "in Auto mode with the account inside the cohort."
    );
    process.exit(1);
}

console.log(
    `traceId ${traceId}\n\n` +
        "Disconnected on the retry signal. Give the server a moment to settle, " +
        "then:\n\n" +
        `  npm run drill:fallback-verify -- --trace ${traceId} \\\n` +
        "      --scenario disconnect_during_fallback --subject <subjectKey> --log <logfile>\n"
);
