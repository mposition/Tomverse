import { MOBILE_AUTH_CALLBACK_PATH, mobileAuthHttpsOrigin } from "./mobileBrowserLogin";

const APP_ID = "app.tomverse.shell";

export const mobileAppLinkOrigin = (env: NodeJS.ProcessEnv = process.env) =>
  mobileAuthHttpsOrigin(env.MOBILE_AUTH_APP_LINK_ORIGIN ?? "");

/** No association is published until actual release-signing identities are configured. */
export const mobileAppLinks = (env: NodeJS.ProcessEnv = process.env) => {
  const returnOrigin = mobileAppLinkOrigin(env);
  if (env.MOBILE_AUTH_APP_LINKS_ENABLED !== "true" || !returnOrigin) return { android: [], ios: [] };
  const fingerprints = (env.MOBILE_AUTH_ANDROID_SHA256_CERT_FINGERPRINTS ?? "")
    .split(",").map((value) => value.trim().toUpperCase()).filter(Boolean);
  const android = fingerprints.length > 0 && fingerprints.every((value) => /^([A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(value))
    ? [{ relation: ["delegate_permission/common.handle_all_urls"], target: {
        namespace: "android_app", package_name: APP_ID, sha256_cert_fingerprints: [...new Set(fingerprints)],
      } }] : [];
  const iosId = env.MOBILE_AUTH_IOS_APP_ID ?? "";
  const loginOrigin = mobileAuthHttpsOrigin(env.NEXTAUTH_URL ?? "https://tomverse.app");
  const ios = loginOrigin && returnOrigin !== loginOrigin && new RegExp(`^[A-Z0-9]{10}\\.${APP_ID.replaceAll(".", "\\.")}$`).test(iosId)
    ? [{ appID: iosId, paths: [MOBILE_AUTH_CALLBACK_PATH] }] : [];
  return { android, ios };
};
