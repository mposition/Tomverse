import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

const usage = "When you ask a location-dependent question or turn on Current location, share your approximate position with AI providers to answer it. Existing device permission is reused. Location is refreshed when sending a message and is not tracked in the background.";

export const withAndroidLocationPermission = (xml) => {
  if (xml.includes('android.permission.ACCESS_COARSE_LOCATION')) return xml;
  if (!xml.includes("</manifest>")) throw new Error("Android manifest closing tag missing.");
  return xml.replace("</manifest>", '    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />\n</manifest>');
};

export const withIosLocationPermission = (xml) => {
  let result = xml;
  // The plugin requires both description keys, including for foreground-only
  // use: https://capacitorjs.com/docs/apis/geolocation#ios . This is disclosure,
  // not an Always authorization request or a UIBackgroundModes entitlement.
  for (const key of ["NSLocationWhenInUseUsageDescription", "NSLocationAlwaysAndWhenInUseUsageDescription"]) {
    if (result.includes(`<key>${key}</key>`)) continue;
    if (!result.includes("</dict>")) throw new Error("iOS plist dictionary closing tag missing.");
    const end = result.lastIndexOf("</dict>");
    result = `${result.slice(0, end)}\t<key>${key}</key>\n\t<string>${usage}</string>\n${result.slice(end)}`;
  }
  if (!result.includes("<key>NSLocationDefaultAccuracyReduced</key>")) {
    const end = result.lastIndexOf("</dict>");
    if (end < 0) throw new Error("iOS plist dictionary closing tag missing.");
    result = `${result.slice(0, end)}\t<key>NSLocationDefaultAccuracyReduced</key>\n\t<true/>\n${result.slice(end)}`;
  }
  return result;
};

export const configureLocationPermissions = (root) => {
  for (const [relativePath, transform] of [
    ["android/app/src/main/AndroidManifest.xml", withAndroidLocationPermission],
    ["ios/App/App/Info.plist", withIosLocationPermission],
  ]) {
    const path = resolve(root, relativePath);
    if (!existsSync(path)) continue;
    const source = readFileSync(path, "utf8");
    const updated = transform(source);
    if (updated !== source) writeFileSync(path, updated, "utf8");
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  configureLocationPermissions(fileURLToPath(new URL("..", import.meta.url)));
}
