import { useState, useSyncExternalStore } from "react";
import { Capacitor } from "@capacitor/core";
import { Geolocation } from "@capacitor/geolocation";
import { createChatLocationSession, type ChatLocation } from "@tomverse/chat-core";
import { createNativeLocationReader } from "./location";

const location = createChatLocationSession(createNativeLocationReader(Geolocation, Capacitor.isNativePlatform()));
const scope = "readiness";

export const LocationReadiness = () => {
  const state = useSyncExternalStore(location.subscribe, location.getSnapshot);
  const [fix, setFix] = useState<ChatLocation | null>(null);
  return <section aria-labelledby="location-readiness-title" style={{ marginTop: 24 }}>
    <h2 id="location-readiness-title">Foreground location readiness</h2>
    <p>Location is off by default. This check reads an approximate device position locally and sends nothing to the API. The shared chat session refreshes the fix for each message. No background tracking.</p>
    <button type="button" onClick={() => {
      setFix(null);
      if (state.enabled || state.pending) location.disable();
      else void location.enable(scope);
    }}>{state.enabled || state.pending ? "Turn off location" : "Allow current location"}</button>{" "}
    <button type="button" disabled={!state.enabled || state.pending}
      onClick={() => { void location.readForTurn(scope).then(setFix); }}>Read fresh location</button>
    <p role="status">{state.pending ? "Reading current location…" : state.error ? `Location ${state.error}.` : state.enabled ? "Location ready." : "Location off."}</p>
    {fix && state.enabled && <output>{JSON.stringify(fix)}</output>}
  </section>;
};
