import { useSyncExternalStore } from "react";
import { MapPin } from "lucide-react";
import type { ChatTransport } from "./chatTransport";
import { mobileChatCopy } from "../../../locales/mobileChat";
import { mobileComposerToolsCopy } from "../../../locales/mobileComposerTools";

export function NativeLocationControl({ session, identity, language, presentation = "default" }: {
  session: NonNullable<ChatTransport["location"]>;
  identity: string | null;
  language: string;
  presentation?: "default" | "tools";
}) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const copy = mobileChatCopy(language);
  const toolsCopy = mobileComposerToolsCopy(language);
  const tools = presentation === "tools";
  const enabled = session.isEnabled(identity);
  const status = state.error ? copy[state.error] : state.pending ? copy.reading : copy.locationOn;
  const toggle = () => { if (enabled || state.pending) session.disable(); else void session.enable(identity); };
  return <div className={tools ? "tool-location" : undefined}>
    <label className={tools ? "tool-row tool-switch-row" : "switch-field"}>
      {tools && <MapPin className="tool-icon" size={22} aria-hidden="true" />}
      <span className={tools ? "tool-copy" : undefined}>{tools ? toolsCopy.location : copy.location}</span><input type="checkbox" role="switch"
      className={tools ? "tool-switch" : undefined}
      aria-label={tools ? toolsCopy.location : copy.location} aria-describedby="native-location-disclosure" checked={enabled}
      disabled={!identity} onChange={toggle} data-testid="native-location-toggle" /></label>
    <p id="native-location-disclosure" className={tools ? "tool-location-hint" : "field-hint"}>{tools ? toolsCopy.locationNote : copy.locationNote}</p>
    {(state.error || state.pending) && <p role="status">{status}</p>}
  </div>;
}
