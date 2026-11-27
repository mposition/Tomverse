/**
 * The voice conversation's `fetch`. The window holds no sign-in token: each of the client's posts to
 * `/api/chat/voice` is handed to the main process, and a session's event stream comes back as a stream here.
 */
export const desktopVoiceFetch: typeof fetch = async (_path, init) => {
  const signal = init?.signal ?? undefined;
  const aborted = () => new DOMException("The voice request was stopped.", "AbortError");
  if (signal?.aborted) throw aborted();
  const id = crypto.randomUUID();
  const encoder = new TextEncoder();
  let finished = false;
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { stream = controller; },
    cancel() { finish(); void window.desktop.abortVoice(id).catch(() => {}); },
  });
  // Subscribed before the request is sent: the first events can arrive before its reply does.
  const unsubscribe = window.desktop.subscribeVoiceStream((event) => {
    if (event.id !== id || finished) return;
    if (event.chunk) stream.enqueue(encoder.encode(event.chunk));
    if (event.end) {
      finish();
      if (event.end === "done") stream.close(); else stream.error(new TypeError("The voice connection was lost."));
    }
  });
  const abort = () => {
    void window.desktop.abortVoice(id).catch(() => {});
    if (finished) return;
    finish();
    try { stream.error(aborted()); } catch { /* already closed */ }
  };
  function finish() {
    finished = true;
    unsubscribe();
    signal?.removeEventListener("abort", abort);
  }
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const reply = await window.desktop.voiceRequest({ id, body: JSON.parse(String(init?.body)) });
    if (signal?.aborted) throw aborted();
    if (!reply.status) throw new TypeError("The voice request did not reach Tomverse.");
    if (reply.stream) return new Response(body, { status: reply.status, headers: { "Content-Type": "text/event-stream" } });
    finish();
    return new Response(reply.body ?? "", { status: reply.status, headers: { "Content-Type": "application/json" } });
  } catch (error) {
    finish();
    throw error;
  }
};
