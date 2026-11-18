import { Capacitor } from "@capacitor/core";

import { CHAT_MAX_ATTACHMENT_BYTES } from "../../../lib/chatAttachmentLimits";
import { NativeFiles } from "./fileSave";

/** Signed R2 uploads carry file bytes only, never a Tomverse credential. */
export function validateMobileUpload(url: string, headers: Record<string, string>) {
  const target = new URL(url);
  if (target.protocol !== "https:" || !/^[a-z0-9-]+\.r2\.cloudflarestorage\.com$/.test(target.hostname) ||
      target.username || target.password || target.port || target.hash || url.length > 8192 ||
      !target.searchParams.has("X-Amz-Signature")) throw Error("UNSAFE_UPLOAD_URL");
  if (Object.keys(headers).length > 12 || Object.entries(headers).some(([key, value]) =>
    !/^(content-type|x-amz-[a-z0-9-]+)$/i.test(key) || value.length > 2048 || /[\r\n]/.test(value))) throw Error("UNSAFE_UPLOAD_HEADERS");
}

/**
 * The file as base64, encoded by the WebView itself in one pass. Building a
 * byte array and a binary string first held the file in memory three times
 * over, which a 50 MB attachment cannot afford (review r-20261118-081025-978715).
 */
export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(Error("UPLOAD_FAILED"));
    reader.onload = () => {
      const url = typeof reader.result === "string" ? reader.result : "";
      const comma = url.indexOf(",");
      if (comma < 0) reject(Error("UPLOAD_FAILED"));
      else resolve(url.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

export async function uploadMobileFile(url: string, headers: Record<string, string>, file: File) {
  validateMobileUpload(url, headers);
  if (file.size > CHAT_MAX_ATTACHMENT_BYTES) throw Error("FILE_SIZE_LIMIT");
  if (!Capacitor.isNativePlatform()) {
    const response = await fetch(url, { method: "PUT", headers, body: file, credentials: "omit", redirect: "error" });
    if (!response.ok) throw Error("UPLOAD_FAILED");
    return;
  }
  await NativeFiles.uploadFile({ url, headers, data: await fileToBase64(file) });
}
