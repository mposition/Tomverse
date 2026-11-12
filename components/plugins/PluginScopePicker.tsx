"use client";
import type { PluginServer } from "@/lib/mcpConnectorClientContract";

/** Initial choice: the server's default request scope; nothing when it has none, so the user picks. */
export function initialPluginScopes(server: PluginServer | undefined) {
  return server?.scopes ? (server.defaultScopes || []).filter(scope => server.scopes!.includes(scope)) : [];
}

/** OAuth scopes the user grants this connection; the server re-checks the choice against its bound. */
export function PluginScopePicker({ server, value, onChange, disabled, copy, className }: {
  server: PluginServer; value: string[]; onChange: (scopes: string[]) => void; disabled?: boolean;
  copy: { scopes: string; scopesHelp: string; scopesRequired: string }; className?: string;
}) {
  if (!server.scopes) return null;
  return <fieldset className={className} data-testid="plugin-scope-picker">
    <legend>{copy.scopes}</legend>
    <p>{copy.scopesHelp}</p>
    {server.scopes.map(scope => <label key={scope}>
      <input type="checkbox" disabled={disabled} checked={value.includes(scope)} data-testid="plugin-scope"
        onChange={event => onChange(event.target.checked ? server.scopes!.filter(item => item === scope || value.includes(item)) : value.filter(item => item !== scope))} />
      <code>{scope}</code>
    </label>)}
    {!value.length && <p role="alert">{copy.scopesRequired}</p>}
  </fieldset>;
}
