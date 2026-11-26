import { randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import {
  DESKTOP_DRIVE_CALLBACK, DESKTOP_DRIVE_PAGE, desktopDriveResult, driveCipher, driveDecode, driveKeyPair, driveProof,
  driveSelection, type DriveSelection,
} from "../../../../lib/desktopDrivePickerContract";

function finish(response: ServerResponse, status: number, message: string) {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'", "X-Content-Type-Options": "nosniff", Connection: "close",
  }).end(message);
}

export async function selectDriveFiles({ origin, language, slots, signal: lifetime, openExternal }: {
  origin: string; language: string; slots: number; signal: AbortSignal; openExternal(url: string): Promise<void>;
}): Promise<DriveSelection | null> {
  const signal = AbortSignal.any([lifetime, AbortSignal.timeout(5 * 60_000)]);
  signal.throwIfAborted();
  const state = randomBytes(32).toString("base64url");
  const pair = await driveKeyPair();
  let resolve!: (selection: DriveSelection | null) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<DriveSelection | null>((accept, refuse) => { resolve = accept; reject = refuse; });
  void promise.catch(() => {});
  let host: string;
  let handled = false;
  const server = createServer({ maxHeaderSize: 24_576, requestTimeout: 5000, headersTimeout: 5000 }, async (request, response) => {
    const [path, query] = (request.url ?? "").split("?", 2);
    if (request.method !== "GET" || path !== DESKTOP_DRIVE_CALLBACK || request.headers.host !== host) {
      return finish(response, 404, "Google Drive callback not found.");
    }
    const params = new URLSearchParams(query);
    const received = params.get("state") ?? "";
    if (received.length !== state.length || !/^[A-Za-z0-9_-]+$/.test(received) ||
        !timingSafeEqual(Buffer.from(state), Buffer.from(received))) {
      return finish(response, 400, "Invalid Google Drive callback.");
    }
    if (handled || signal.aborted) return finish(response, 410, "This file selection is closed.");
    if (params.size === 1) {
      handled = true;
      finish(response, 200, "File selection cancelled. Return to Tomverse Desktop.");
      resolve(null);
      return;
    }
    const result = desktopDriveResult.safeParse(Object.fromEntries(params));
    if (!result.success || params.size !== 4) return finish(response, 400, "Invalid Google Drive selection.");
    try {
      const cipher = await driveCipher(pair.privateKey, result.data.key);
      const bytes = await crypto.subtle.decrypt(driveProof(state, driveDecode(result.data.iv)), cipher, driveDecode(result.data.payload));
      const selection = driveSelection.parse(JSON.parse(new TextDecoder().decode(bytes)));
      if (selection.files.length > slots) return finish(response, 400, "Too many files were selected.");
      if (handled || signal.aborted) return finish(response, 410, "This file selection is closed.");
      handled = true;
      finish(response, 200, "File selection received. Return to Tomverse Desktop.");
      resolve(selection);
    } catch {
      finish(response, 400, "Google Drive could not confirm the selected files.");
    }
  });
  const onAbort = () => reject(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    server.listen({ port: 0, host: "127.0.0.1", signal });
    await once(server, "listening", { signal });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not open the Google Drive callback.");
    host = "127.0.0.1:" + address.port;
    const picker = new URL(DESKTOP_DRIVE_PAGE, origin);
    picker.searchParams.set("lang", language);
    picker.hash = new URLSearchParams({ port: String(address.port), state, key: pair.key, slots: String(slots) }).toString();
    await Promise.race([openExternal(picker.href), promise]);
    return await promise;
  } finally {
    signal.removeEventListener("abort", onAbort);
    server.close();
    if (!handled) server.closeAllConnections();
  }
}
