import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

export const withBillingLaunchMode = (xml) => xml.replace(/<activity\b[^>]*>/g, (activity) => {
  if (!/android:name="(?:\.MainActivity|[^"]*\.MainActivity)"/.test(activity)) return activity;
  if (/android:launchMode="[^"]*"/.test(activity)) return activity.replace(/android:launchMode="[^"]*"/, 'android:launchMode="singleTop"');
  return activity.replace(/>$/, ' android:launchMode="singleTop">');
});
export function configureStoreBilling(root) {
  const path = resolve(root, "android/app/src/main/AndroidManifest.xml");
  if (!existsSync(path)) return;
  const before = readFileSync(path, "utf8"); const after = withBillingLaunchMode(before);
  if (before !== after) writeFileSync(path, after, "utf8");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  configureStoreBilling(fileURLToPath(new URL("..", import.meta.url)));
}
