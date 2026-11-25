import { desktopNativeCopy } from "../../../../locales/desktopNative";
import type { CodeEventEntry } from "../contract";

export function desktopCodeNotice(notice: NonNullable<CodeEventEntry["notice"]>): CodeEventEntry {
  return { role: "event", text: desktopNativeCopy.en[notice], notice };
}
