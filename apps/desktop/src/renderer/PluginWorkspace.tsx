/* eslint-disable @next/next/no-img-element -- Electron bundles local renderer assets with Vite. */
import { useEffect, useState } from "react";
import { ExternalLink, Puzzle } from "lucide-react";
import type { Language } from "../../../../lib/language";
import { mcpConnectorCopy } from "../../../../lib/mcpConnectorCopy";
import { pluginLogo } from "../../../../lib/mcpConnectorClientContract";
import type { DesktopPluginInventory } from "../plugin-contract";

const logos = import.meta.glob<string>("../../../../public/plugins/providers/*.{png,svg}", {
  eager: true, query: "?url", import: "default",
});

function ServiceLogo({ id, custom }: { id: string; custom: boolean }) {
  const path = custom ? undefined : pluginLogo(id);
  const src = path && logos["../../../../public" + path];
  const [failed, setFailed] = useState(false);
  return <span className="desktop-plugin-logo" aria-hidden="true">
    {src && !failed ? <img src={src} alt="" width={24} height={24} onError={() => setFailed(true)} />
      : <Puzzle size={24} />}
  </span>;
}

export function PluginWorkspace({ language }: { language: Language }) {
  const copy = mcpConnectorCopy[language];
  const [inventory, setInventory] = useState<DesktopPluginInventory>();
  const [failed, setFailed] = useState(false);
  const [connectedOnly, setConnectedOnly] = useState(false);
  const [query, setQuery] = useState("");
  useEffect(() => {
    let active = true;
    void window.desktop.pluginInventory().then((result) => { if (active) setInventory(result); },
      () => { if (active) setFailed(true); });
    return () => { active = false; };
  }, []);

  const manage = () => void window.desktop.openWeb("plugins").catch(() => setFailed(true));
  const connected = new Map(inventory?.connections.filter(({ status }) => status !== "disconnected")
    .map((connection) => [connection.serverId, connection]));
  const rows = inventory?.servers.filter(({ id, name }) =>
    (!connectedOnly || connected.has(id)) && name.toLocaleLowerCase(language).includes(query.trim().toLocaleLowerCase(language)));
  return <section className="desktop-plugins" aria-label={copy.title}>
    <div className="desktop-plugins-heading">
      <div><h2>{copy.title}</h2><p>{copy.subtitle}</p></div>
      <button type="button" className="primary" onClick={manage}><ExternalLink size={15} />{copy.open}</button>
    </div>
    <div className="desktop-plugins-controls">
      <button type="button" className="soft" aria-pressed={!connectedOnly} onClick={() => setConnectedOnly(false)}>{copy.all}</button>
      <button type="button" className="soft" aria-pressed={connectedOnly} onClick={() => setConnectedOnly(true)}>{copy.connected}</button>
      <input type="search" className="history-search" aria-label={copy.search} placeholder={copy.search} value={query}
        onChange={(event) => setQuery(event.currentTarget.value)} />
    </div>
    {failed && <p role="alert" className="notice">{copy.error}</p>}
    {inventory?.enabled === false && <p className="notice">{copy.disabled}</p>}
    {inventory?.enabled && !rows?.length && <p className="notice">{query.trim() ? copy.missing : copy.empty}</p>}
    <ul className="desktop-plugin-list">{rows?.map(({ id, name, custom }) => {
      const connection = connected.get(id);
      const state = connection?.status === "connected" ? copy.connected : connection ? copy.unavailable : copy.notConnected;
      return <li key={id}>
        <ServiceLogo id={id} custom={custom} />
        <div><strong>{name}</strong><p>{state}{connection && ` · ${copy.tools} ${connection.granted}/${connection.tools}`}</p></div>
      </li>;
    })}</ul>
  </section>;
}
