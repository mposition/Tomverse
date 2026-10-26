import { Capacitor } from "@capacitor/core";
import { Geolocation } from "@capacitor/geolocation";
import { createChatLocationSession } from "@tomverse/chat-core";
import { createNativeLocationReader } from "./location";

export const nativeChatLocation = createChatLocationSession(
  createNativeLocationReader(Geolocation, Capacitor.isNativePlatform()),
);
