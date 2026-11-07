import type { AdminTone } from "@/lib/adminUiCore";

/**
 * The tone of an optimizer cycle's status. A status the console does not know
 * is drawn as idle rather than as healthy or failed.
 */
export function optimizerCycleTone(status: string): AdminTone {
  switch (status) {
    case "running":
      return "info";
    case "passed":
      return "ok";
    case "failed":
      return "warn";
    case "error":
      return "bad";
    default:
      return "idle";
  }
}
