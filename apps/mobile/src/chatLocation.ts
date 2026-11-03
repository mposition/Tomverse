import { Capacitor } from "@capacitor/core";
import { Geolocation } from "@capacitor/geolocation";
import { createChatLocationSession } from "@tomverse/chat-core";
import { createNativeLocationReader } from "./location";
import { createNativeLocationConsent } from "./locationConsent";

const session = createChatLocationSession(
  createNativeLocationReader(Geolocation, Capacitor.isNativePlatform()),
);
export const nativeLocationConsent = createNativeLocationConsent(session, Geolocation, Capacitor.isNativePlatform(), {
  getItem: key => globalThis.localStorage?.getItem(key) ?? null,
  setItem: (key, value) => globalThis.localStorage?.setItem(key, value),
});
export const nativeChatLocation = nativeLocationConsent.location;
