import { codeManagedEnabled } from "./codeManagedCore";

/**
 * Desktop's managed Code credits screen (reserve, keep alive, release). A display switch only: Desktop reaches
 * `/api/code/managed` with the account settings session, the same way a web page does, so it enrols no bearer route and
 * changes no price, credit or reservation rule. It stays off unless the account settings session and the server's own
 * managed-execution switch are on too.
 */
export function desktopManagedCodeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.TOMVERSE_DESKTOP_AUTH_ENABLED === "true" &&
    env.TOMVERSE_DESKTOP_ACCOUNT_SETTINGS_ENABLED === "true" &&
    env.TOMVERSE_DESKTOP_MANAGED_CODE_ENABLED === "true" &&
    codeManagedEnabled(env);
}
