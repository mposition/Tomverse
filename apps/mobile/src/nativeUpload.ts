import { Capacitor } from "@capacitor/core";

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

export async function uploadMobileFile(url: string, headers: Record<string, string>, file: File) {
  validateMobileUpload(url, headers);
  if (file.size > 64 * 1024 * 1024) throw Error("FILE_SIZE_LIMIT");
  if (!Capacitor.isNativePlatform()) {
    const response = await fetch(url, { method: "PUT", headers, body: file, credentials: "omit", redirect: "error" });
    if (!response.ok) throw Error("UPLOAD_FAILED");
    return;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  await NativeFiles.uploadFile({ url, headers, data: btoa(binary) });
}
