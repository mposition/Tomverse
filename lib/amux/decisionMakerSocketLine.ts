import type { Duplex } from "node:stream";

/**
 * One line of the AMUX Decision Maker's local socket protocols
 * (docs/policy/amux-decision-maker.md §5, stage S2-3b): bridge to broker and
 * broker to launcher. A message is one JSON text and a `\n`; JSON escapes
 * every newline inside a string, so the first `\n` ends the message. Each
 * side writes one line and then waits, so bytes after the line in the same
 * read are a protocol fault, not the next message.
 *
 * Every read has a byte cap and a deadline, and never throws: a stream that
 * ends, errors, overruns the cap or stays silent is an answer, not an
 * exception.
 */

export type DmLineReadError = "timeout" | "too_large" | "closed" | "not_utf8" | "trailing_bytes";

export type DmLineRead = { ok: true; line: string } | { ok: false; error: DmLineReadError };

const NEWLINE = 0x0a;

const decodeUtf8 = (bytes: Uint8Array): string | null => {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
};

/** Reads one line of at most `maxBytes` (the `\n` not counted) within `timeoutMs`. */
export const dmReadLine = (stream: Duplex, maxBytes: number, timeoutMs: number): Promise<DmLineRead> =>
  new Promise((resolve) => {
    if (stream.destroyed || stream.readableEnded) {
      resolve({ ok: false, error: "closed" });
      return;
    }
    const chunks: Buffer[] = [];
    let length = 0;
    let done = false;

    const finish = (result: DmLineRead) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("end", onClosed);
      stream.off("close", onClosed);
      stream.off("error", onClosed);
      stream.pause();
      resolve(result);
    };

    const onData = (chunk: Buffer | string) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      const newline = bytes.indexOf(NEWLINE);
      const taken = newline === -1 ? bytes : bytes.subarray(0, newline);
      if (length + taken.length > maxBytes) {
        finish({ ok: false, error: "too_large" });
        return;
      }
      chunks.push(taken);
      length += taken.length;
      if (newline === -1) return;
      if (newline < bytes.length - 1) {
        finish({ ok: false, error: "trailing_bytes" });
        return;
      }
      const line = decodeUtf8(Buffer.concat(chunks, length));
      finish(line === null ? { ok: false, error: "not_utf8" } : { ok: true, line });
    };
    const onClosed = () => finish({ ok: false, error: "closed" });
    const timer = setTimeout(() => finish({ ok: false, error: "timeout" }), timeoutMs);

    stream.on("data", onData);
    stream.once("end", onClosed);
    stream.once("close", onClosed);
    stream.once("error", onClosed);
    stream.resume();
  });

/** Writes one JSON value as a line. True once the bytes were handed to the stream without error. */
export const dmWriteLine = (stream: Duplex, value: unknown, timeoutMs: number): Promise<boolean> =>
  new Promise((resolve) => {
    if (stream.destroyed || stream.writableEnded) {
      resolve(false);
      return;
    }
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stream.off("error", onError);
      resolve(ok);
    };
    const onError = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    stream.once("error", onError);
    try {
      stream.write(`${JSON.stringify(value)}\n`, (error) => finish(!error));
    } catch {
      finish(false);
    }
  });

/** Ends the stream and lets it go within `timeoutMs`, whatever the peer does. */
export const dmCloseStream = (stream: Duplex, timeoutMs: number): Promise<void> =>
  new Promise((resolve) => {
    if (stream.destroyed) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      stream.destroy();
      resolve();
    }, timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      stream.destroy();
      resolve();
    };
    stream.once("error", finish);
    try {
      stream.end(finish);
    } catch {
      finish();
    }
  });
