import { Capacitor, registerPlugin } from "@capacitor/core";
import { saveBlobAsFile, filenameFromContentDisposition } from "../../../lib/browserDownload";

const NativeFiles = registerPlugin<{ saveFile(input: { filename: string; mediaType: string; data: string }): Promise<void> }>("MobileFiles");

export async function saveMobileResponse(response: Response, fallback: string) {
  const filename = filenameFromContentDisposition(response.headers.get("content-disposition"), fallback).replace(/[\\/\x00-\x1f]/g, "_").slice(0, 160);
  const blob = await response.blob();
  if (blob.size > 64 * 1024 * 1024) throw Error("FILE_SIZE_LIMIT");
  if (!Capacitor.isNativePlatform()) { saveBlobAsFile(blob, filename); return; }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  await NativeFiles.saveFile({ filename, mediaType: blob.type || "application/octet-stream", data: btoa(binary) });
}
