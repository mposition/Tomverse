/**
 * Whether the operating system lets this app read the device position. It is asked only after a position read
 * failed, to choose between the generic message and one that points at the Windows setting. Nothing here is
 * built from a renderer value: the registry paths are fixed, and the one package name used comes from the path
 * of this running executable.
 */
export type OsLocationStatus = "off" | "on" | "unknown";

/** The one address the settings button opens. A fixed Windows settings page, never a web address. */
export const WINDOWS_LOCATION_SETTINGS_URI = "ms-settings:privacy-location";

const CONSENT_STORE = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\location";
const PACKAGE_FAMILY = /^[A-Za-z0-9.-]{3,50}_[a-z0-9]{13}$/;
const PACKAGED_PATH = /\\WindowsApps\\([A-Za-z0-9.-]{3,50})_[^_\\]+_[^_\\]*_[^_\\]*_([a-z0-9]{13})\\/i;

/** The package family of a packaged (MSIX) install, read from where the executable runs; nothing for a plain install. */
export function packageFamilyFromExecutable(executablePath: string): string | undefined {
  const match = PACKAGED_PATH.exec(executablePath);
  const family = match ? `${match[1]}_${match[2]!.toLowerCase()}` : undefined;
  return family && PACKAGE_FAMILY.test(family) ? family : undefined;
}

type ConsentQuery = { hive: "HKLM" | "HKCU"; key: string; role: "system" | "user" | "app" };

/** The fixed list of `reg query` targets: the machine switch, the user switch, then this app's own entry. */
export function consentQueries(packageFamily?: string): ConsentQuery[] {
  const app = packageFamily && PACKAGE_FAMILY.test(packageFamily) ? packageFamily : "NonPackaged";
  return [
    { hive: "HKLM", key: CONSENT_STORE, role: "system" },
    { hive: "HKCU", key: CONSENT_STORE, role: "user" },
    { hive: "HKCU", key: `${CONSENT_STORE}\\${app}`, role: "app" },
  ];
}

/** The `Value` of a `reg query ... /v Value` answer (Allow, Deny, ...), or nothing when the answer has none. */
export function parseConsentValue(output: string): string | undefined {
  return /^\s*Value\s+REG_SZ\s+(\S+)\s*$/im.exec(output)?.[1];
}

/**
 * Any Deny is off. On needs both the machine and the user switch to read Allow; this app's own entry may be
 * missing (it does not exist before the first request). Anything else, including a failed read, is unknown.
 */
export function decideOsLocation(values: { system?: string; user?: string; app?: string }): OsLocationStatus {
  const is = (value: string | undefined, expected: string) => value?.toLowerCase() === expected;
  if (is(values.system, "deny") || is(values.user, "deny") || is(values.app, "deny")) return "off";
  return is(values.system, "allow") && is(values.user, "allow") ? "on" : "unknown";
}

/** Runs `reg.exe` with the given fixed arguments and returns its output; it rejects when the value cannot be read. */
export type RegistryQuery = (args: string[]) => Promise<string>;

export async function readOsLocationStatus(options: {
  platform: NodeJS.Platform; executablePath: string; query: RegistryQuery;
}): Promise<OsLocationStatus> {
  if (options.platform !== "win32") return "unknown";
  const values: { system?: string; user?: string; app?: string } = {};
  await Promise.all(consentQueries(packageFamilyFromExecutable(options.executablePath)).map(async ({ hive, key, role }) => {
    try { values[role] = parseConsentValue(await options.query(["query", `${hive}\\${key}`, "/v", "Value"])); } catch { /* unreadable stays unknown */ }
  }));
  return decideOsLocation(values);
}
