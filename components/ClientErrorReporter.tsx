"use client";

import { useEffect } from "react";
import { installClientErrorListeners } from "@/lib/clientErrorReporter";

/**
 * Mounted once in the shared document shell. Renders nothing; collects the
 * errors no component caught (`error` and `unhandledrejection`) and sends them
 * to the same-origin collection route. The route decides whether reporting is
 * switched on, so this component needs no server-read flag and the statically
 * prerendered marketing pages need no rebuild to follow the switch.
 */
export function ClientErrorReporter() {
  useEffect(() => installClientErrorListeners(), []);
  return null;
}
