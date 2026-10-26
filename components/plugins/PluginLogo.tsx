import { Puzzle } from "lucide-react";
import Image from "next/image";
import { pluginLogo } from "@/lib/mcpConnectorClientContract";
export function PluginLogo({ name }: { name: string }) {
  const src = pluginLogo(name);
  return <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-zinc-200 bg-white p-2 text-blue-600" aria-hidden="true">
    {src ? <Image unoptimized src={src} width={24} height={24} alt="" /> : <Puzzle size={23} />}
  </span>;
}
