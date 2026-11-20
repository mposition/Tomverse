"use client";

import { useState } from "react";
import { useAccountMemorySettings } from "@/components/chat/useAccountMemorySettings";

export function MemorySettingsHarness() {
  const [userId, setUserId] = useState<string | null>("account-a");
  const { settings, refresh } = useAccountMemorySettings(userId);
  return (
    <main>
      <p data-testid="settings-owner">{userId ?? "guest"}</p>
      <output data-testid="settings-snapshot">
        {settings ? `${settings.masterEnabled ? "allowed" : "off"}:${settings.defaultConversationMode}` : "unknown"}
      </output>
      <button onClick={() => setUserId("account-a")}>Account A</button>
      <button onClick={() => setUserId("account-b")}>Account B</button>
      <button onClick={() => setUserId(null)}>Guest</button>
      <button onClick={refresh}>Refresh settings</button>
    </main>
  );
}
