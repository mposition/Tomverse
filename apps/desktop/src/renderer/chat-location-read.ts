import { CHAT_LOCATION_TIMEOUT_MS, type ChatLocation } from "@tomverse/chat-core";

/**
 * One device position read for one message. The host must allow it first (it grants a single read
 * to the main window while an account is signed in); without that grant nothing is read.
 */
export async function readDesktopLocation(
  arm: () => Promise<boolean>,
  read: () => Promise<ChatLocation>,
): Promise<ChatLocation> {
  if (!await arm()) throw new Error("unavailable");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([read(), new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("timeout")), CHAT_LOCATION_TIMEOUT_MS + 500);
    })]);
  } finally { clearTimeout(timeout); }
}
