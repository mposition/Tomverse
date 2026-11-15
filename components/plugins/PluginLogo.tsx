"use client";
import { useState } from "react";
import { Puzzle } from "lucide-react";
import Image from "next/image";
import { pluginLogo } from "@/lib/mcpConnectorClientContract";

// The service's first letter stands in when its logo is missing or fails to load, so a card never shows an empty frame.
export const pluginLogoInitial = (name: string) => name.trim().match(/[\p{L}\p{N}]/u)?.[0]?.toUpperCase() || "";

export function PluginLogo({ name, providerId }: { name: string; providerId?: string }) {
  const src = pluginLogo(providerId || name);
  const [failed, setFailed] = useState<string>();
  const initial = pluginLogoInitial(name);
  return <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-zinc-200 bg-white p-2 text-blue-600" aria-hidden="true">
    {src && failed !== src ? <Image unoptimized loading="eager" src={src} width={24} height={24} alt="" className="object-contain" onError={() => setFailed(src)} />
      : src && initial ? <span className="text-base font-semibold" data-testid="plugin-logo-fallback">{initial}</span> : <Puzzle size={23} />}
  </span>;
}
