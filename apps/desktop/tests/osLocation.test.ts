import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  consentQueries, decideOsLocation, packageFamilyFromExecutable, parseConsentValue, readOsLocationStatus, WINDOWS_LOCATION_SETTINGS_URI,
} from "../src/host/os-location";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const SYSTEM = "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\location";
const USER = SYSTEM.replace("HKLM", "HKCU");
const answer = (key: string, value: string) => `\r\n${key.replace(/^HKLM/, "HKEY_LOCAL_MACHINE").replace(/^HKCU/, "HKEY_CURRENT_USER")}\r\n    Value    REG_SZ    ${value}\r\n\r\n`;
const PACKAGED = "C:\\Program Files\\WindowsApps\\Tomverse.Desktop.LocalDev_0.1.0.0_x64__570ybbrr1s9m0\\app\\Tomverse.exe";

/** A fake `reg.exe`: the values are by key; a key not listed fails like a missing key. */
function registry(values: Record<string, string>) {
  const asked: string[][] = [];
  return {
    asked,
    query: async (args: string[]) => {
      asked.push(args);
      const key = args[1]!;
      if (!(key in values)) throw new Error("ERROR: The system was unable to find the specified registry key or value.");
      return answer(key, values[key]!);
    },
  };
}
const status = (values: Record<string, string>, extra: { platform?: NodeJS.Platform; executablePath?: string } = {}) => {
  const fake = registry(values);
  return readOsLocationStatus({ platform: "win32", executablePath: "C:\\Tomverse\\Tomverse.exe", ...extra, query: fake.query }).then((result) => ({ result, asked: fake.asked }));
};

test("A reg query answer is read for its Value and nothing else", () => {
  assert.equal(parseConsentValue(answer(SYSTEM, "Deny")), "Deny");
  assert.equal(parseConsentValue(answer(SYSTEM, "Allow")), "Allow");
  assert.equal(parseConsentValue("    Other    REG_SZ    Deny"), undefined);
  assert.equal(parseConsentValue("    Value    REG_DWORD    0x1"), undefined);
  assert.equal(parseConsentValue(""), undefined);
});

test("Windows location is off when any switch is Deny, on only when the machine and user switches both Allow", () => {
  assert.equal(decideOsLocation({ system: "Deny", user: "Deny", app: "Allow" }), "off");
  assert.equal(decideOsLocation({ system: "Allow", user: "Deny" }), "off");
  assert.equal(decideOsLocation({ system: "Allow", user: "Allow", app: "Deny" }), "off");
  assert.equal(decideOsLocation({ system: "deny", user: "Allow" }), "off", "the comparison ignores case");
  assert.equal(decideOsLocation({ system: "Allow", user: "Allow", app: "Allow" }), "on");
  assert.equal(decideOsLocation({ system: "Allow", user: "Allow" }), "on", "this app's own entry does not exist before its first request");
  assert.equal(decideOsLocation({ system: "Allow", user: "Allow", app: "Prompt" }), "on");
  assert.equal(decideOsLocation({ system: "Allow" }), "unknown", "one unreadable switch is not a yes");
  assert.equal(decideOsLocation({}), "unknown");
});

test("The operator's machine reads off: machine and user location Deny, while the app entries are Allow", async () => {
  const { result } = await status({ [SYSTEM]: "Deny", [USER]: "Deny", [`${USER}\\NonPackaged`]: "Allow" });
  assert.equal(result, "off");
});

test("A plain install reads the machine, user and NonPackaged entries with fixed reg arguments", async () => {
  const { result, asked } = await status({ [SYSTEM]: "Allow", [USER]: "Allow", [`${USER}\\NonPackaged`]: "Allow" });
  assert.equal(result, "on");
  assert.deepEqual(asked.map((args) => args[1]).sort(), [SYSTEM, USER, `${USER}\\NonPackaged`].sort());
  for (const args of asked) assert.deepEqual([args[0], args[2], args[3], args.length], ["query", "/v", "Value", 4]);
});

test("A packaged install reads its own package family entry instead of NonPackaged", async () => {
  assert.equal(packageFamilyFromExecutable(PACKAGED), "Tomverse.Desktop.LocalDev_570ybbrr1s9m0");
  const family = `${USER}\\Tomverse.Desktop.LocalDev_570ybbrr1s9m0`;
  const off = await status({ [SYSTEM]: "Allow", [USER]: "Allow", [family]: "Deny" }, { executablePath: PACKAGED });
  assert.equal(off.result, "off");
  assert.ok(off.asked.some((args) => args[1] === family));
  assert.ok(!off.asked.some((args) => String(args[1]).endsWith("NonPackaged")));
  const on = await status({ [SYSTEM]: "Allow", [USER]: "Allow", [family]: "Allow" }, { executablePath: PACKAGED });
  assert.equal(on.result, "on");
});

test("Only a well-formed package family reaches a reg argument", () => {
  assert.equal(packageFamilyFromExecutable("C:\\Tomverse\\Tomverse.exe"), undefined);
  assert.equal(packageFamilyFromExecutable("C:\\Program Files\\WindowsApps\\bad name_1_x64__570ybbrr1s9m0\\a.exe"), undefined);
  assert.equal(packageFamilyFromExecutable("C:\\Program Files\\WindowsApps\\Tomverse.Desktop_1.0.0.0_x64__short\\a.exe"), undefined);
  const hostile = consentQueries('Evil" /f & calc_570ybbrr1s9m0');
  assert.ok(hostile.every((query) => !query.key.includes("Evil")), "an invalid family falls back to NonPackaged");
  assert.ok(hostile.some((query) => query.key.endsWith("\\NonPackaged")));
});

test("A failed read is unknown, never off", async () => {
  assert.equal((await status({})).result, "unknown");
  assert.equal((await status({ [SYSTEM]: "Allow" })).result, "unknown");
  assert.equal((await status({ [SYSTEM]: "Allow", [USER]: "Allow" })).result, "on");
  // One Deny is enough even when the other reads fail.
  assert.equal((await status({ [USER]: "Deny" })).result, "off");
  const broken = await readOsLocationStatus({ platform: "win32", executablePath: "x", query: async () => "garbage" });
  assert.equal(broken, "unknown");
});

test("Other systems are unknown and run nothing", async () => {
  for (const platform of ["darwin", "linux"] as const) {
    const { result, asked } = await status({ [SYSTEM]: "Deny", [USER]: "Deny" }, { platform });
    assert.equal(result, "unknown");
    assert.deepEqual(asked, []);
  }
});

test("The IPC contract: both channels take nothing from the renderer and go through the trusted-window wrapper", () => {
  const preload = read("../src/host/preload.ts");
  assert.match(preload, /osLocationStatus: \(\) => ipcRenderer\.invoke\("desktop:location-os-status"\),/);
  assert.match(preload, /openOsLocationSettings: \(\) => ipcRenderer\.invoke\("desktop:location-open-settings"\),/);
  const contract = read("../src/contract.ts");
  assert.match(contract, /osLocationStatus: \(\) => Promise<"off" \| "on" \| "unknown">;/);
  assert.match(contract, /openOsLocationSettings: \(\) => Promise<boolean>;/);
  const main = read("../src/host/main.ts");
  assert.match(main, /^ {2}main\("desktop:location-os-status", \(\) => osLocationStatus\(\)\);$/m);
  assert.match(main, /^ {2}main\("desktop:location-open-settings", \(\) => openOsLocationSettings\(\)\);$/m);
  assert.match(main, /async function osLocationStatus\(\)/);
  assert.match(main, /async function openOsLocationSettings\(\)/);
  assert.equal(WINDOWS_LOCATION_SETTINGS_URI, "ms-settings:privacy-location");
});

test("The settings button and the Windows wording are only shown when the host answered off", () => {
  const view = read("../src/renderer/ChatDraftLocation.tsx");
  assert.match(view, /off: status === "off"/);
  assert.match(view, /const windowsOff = Boolean\(state\.error\) && osCheck\?\.failure === state && osCheck\.off;/);
  assert.match(view, /state\.error && location\.windowsOff &&/);
  for (const language of ["en", "ko", "de", "es", "fr", "pt", "zh", "zhHant"]) {
    const locale = read(`../../../locales/${language}.ts`);
    assert.match(locale, /locationWindowsOff: "/, language);
    assert.match(locale, /locationOpenWindowsSettings: "/, language);
  }
});
