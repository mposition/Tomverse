import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

const callbackPath = "/mobile/auth/callback";
const start = "<!-- tomverse-auth-app-link -->";
const end = "<!-- /tomverse-auth-app-link -->";
const managed = /<!-- tomverse-auth-app-link -->[\s\S]*?<!-- \/tomverse-auth-app-link -->/g;
const managedDomains = /<!-- tomverse-auth-domains -->[\s\S]*?<!-- \/tomverse-auth-domains -->/g;
const managedSigning = /\s*CODE_SIGN_ENTITLEMENTS = App\/TomverseAuth\.entitlements; \/\* tomverse-auth-app-link \*\//g;

export const authLinkHost = (origin) => {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      url.pathname !== "/" || url.search || url.hash || !/^[a-z0-9.-]+$/.test(url.hostname)) {
    throw new Error("App links require an exact HTTPS origin on the default port.");
  }
  return url.hostname;
};

export const withAndroidAuthAppLink = (xml, host) => {
  if (!host) return xml.replace(managed, "");
  if (!/^[a-z0-9.-]+$/.test(host)) throw new Error("Invalid app-link host.");
  // The generated Capacitor project has exactly one MainActivity. Do not enroll another activity.
  const activity = /<activity\b[^>]*android:name="(?:[^\"]*\.)?MainActivity"[^>]*>[\s\S]*?<\/activity>/g;
  const matches = [...xml.matchAll(activity)];
  if (matches.length !== 1) throw new Error("Expected one Capacitor MainActivity.");
  const filter = `${start}\n            <intent-filter android:autoVerify="true">\n                <action android:name="android.intent.action.VIEW" />\n                <category android:name="android.intent.category.DEFAULT" />\n                <category android:name="android.intent.category.BROWSABLE" />\n                <data android:scheme="https" android:host="${host}" android:path="${callbackPath}" />\n            </intent-filter>\n            ${end}`;
  if (xml.includes(start)) return xml.replace(managed, filter);
  return xml.replace(activity, (block) => block.replace("</activity>", `\n            ${filter}\n        </activity>`));
};

export const withIosAuthAppLink = (xml, host) => {
  if (!host) return xml.replace(managedDomains, "").replace(managed, "");
  if (!/^[a-z0-9.-]+$/.test(host)) throw new Error("Invalid app-link host.");
  const entry = `${start}\n        <string>applinks:${host}</string>\n        ${end}`;
  if (xml.includes(start)) return xml.replace(managed, entry);
  const source = xml;
  const existing = /(<key>com\.apple\.developer\.associated-domains<\/key>\s*<array>)([\s\S]*?)(<\/array>)/;
  if (existing.test(source)) return source.replace(existing, `$1$2\n        ${entry}\n    $3`);
  if (source.includes("<key>com.apple.developer.associated-domains</key>")) throw new Error("Associated Domains must be an array.");
  const close = source.lastIndexOf("</dict>");
  if (close < 0) throw new Error("Invalid entitlements plist.");
  return `${source.slice(0, close)}    <!-- tomverse-auth-domains -->\n    <key>com.apple.developer.associated-domains</key>\n    <array>\n        ${entry}\n    </array>\n    <!-- /tomverse-auth-domains -->\n${source.slice(close)}`;
};

export const configureAuthAppLinks = (root, env = process.env) => {
  if (env.NATIVE_AUTH_APP_LINKS_ENABLED === "true" && !env.VITE_MOBILE_AUTH_APP_LINK_ORIGIN) {
    throw new Error("VITE_MOBILE_AUTH_APP_LINK_ORIGIN is required when native auth app links are enabled.");
  }
  const host = env.NATIVE_AUTH_APP_LINKS_ENABLED === "true"
    ? authLinkHost(env.VITE_MOBILE_AUTH_APP_LINK_ORIGIN) : null;
  const update = (path, transform) => {
    if (!existsSync(path)) return;
    const source = readFileSync(path, "utf8");
    const updated = transform(source);
    if (source !== updated) writeFileSync(path, updated, "utf8");
  };
  update(resolve(root, "android/app/src/main/AndroidManifest.xml"), (xml) => withAndroidAuthAppLink(xml, host));
  const project = resolve(root, "ios/App/App.xcodeproj/project.pbxproj");
  if (!existsSync(project)) return;
  // Keep any existing entitlements file rather than replacing the app's other capabilities.
  const source = readFileSync(project, "utf8");
  const settings = [...source.matchAll(/CODE_SIGN_ENTITLEMENTS = "?([^";]+)"?;/g)].map((match) => match[1]);
  const names = [...new Set(settings)];
  if (names.length > 1 || (names.length && !/^App\/[A-Za-z0-9_.-]+\.entitlements$/.test(names[0]))) {
    if (host) throw new Error("Select a single App/*.entitlements file for the iOS target before enabling auth links.");
    return;
  }
  const name = names[0] ?? "App/TomverseAuth.entitlements";
  const entitlements = resolve(root, "ios/App", name);
  if (host && !existsSync(entitlements)) writeFileSync(entitlements, '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n</dict>\n</plist>\n', "utf8");
  update(entitlements, (xml) => withIosAuthAppLink(xml, host));
  // Capabilities added by an operator after setup must keep their signing file.
  if (!host && existsSync(entitlements) && !/<key>/.test(readFileSync(entitlements, "utf8"))) {
    update(project, (text) => text.replace(managedSigning, ""));
  }
  if (host && !names.length) {
    // Limit signing changes to the app target's configurations.
    const blocks = /buildSettings = \{([\s\S]*?)\n\s*\};/g;
    let count = 0;
    const updated = source.replace(blocks, (block) => {
      if (!block.includes("PRODUCT_BUNDLE_IDENTIFIER")) return block;
      count++;
      return block.replace("buildSettings = {", `buildSettings = {\n\t\t\t\tCODE_SIGN_ENTITLEMENTS = ${name}; /* tomverse-auth-app-link */`);
    });
    if (!count) throw new Error("iOS app build settings were not found.");
    writeFileSync(project, updated, "utf8");
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  configureAuthAppLinks(fileURLToPath(new URL("..", import.meta.url)));
}
