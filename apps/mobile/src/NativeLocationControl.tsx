import { useSyncExternalStore } from "react";
import type { ChatTransport } from "./chatTransport";
import { mobileChatCopy } from "../../../locales/mobileChat";

export function NativeLocationControl({ session, identity, language, compact = false }: {
  session: NonNullable<ChatTransport["location"]>;
  identity: string | null;
  language: string;
  compact?: boolean;
}) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const copy = mobileChatCopy(language);
  const enabled = session.isEnabled(identity);
  const status = state.error ? copy[state.error] : state.pending ? copy.reading : copy.locationOn;
  const toggle = () => { if (enabled || state.pending) session.disable(); else void session.enable(identity); };
  if (compact) {
    if (!identity || (!enabled && !state.pending && !state.error)) return null;
    return <div className="notice location-status" data-testid="native-location-status">
      <span role="status">{status}</span>
      <button type="button" onClick={session.disable} aria-label={copy.disable} data-testid="native-location-disable">×</button>
    </div>;
  }
  return <div>
    <label className="switch-field"><span>{copy.location}</span><input type="checkbox" role="switch"
      aria-label={copy.location} aria-describedby="native-location-disclosure" checked={enabled}
      disabled={!identity} onChange={toggle} data-testid="native-location-toggle" /></label>
    <p id="native-location-disclosure" className="field-hint">{copy.locationNote}</p>
    {(state.error || state.pending) && <p role="status">{status}</p>}
  </div>;
}
