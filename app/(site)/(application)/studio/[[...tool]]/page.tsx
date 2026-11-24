import { notFound } from "next/navigation";
import { StudioWorkspace } from "@/components/studio/StudioWorkspace";
import { studioAvailable } from "@/lib/studioAvailability";
import { findStudioTool, STUDIO_PHOTO_PRESETS } from "@/lib/studioTools";

export const metadata = { title: "Tomverse Studio" };

export default async function StudioPage({ params, searchParams }: {
  params: Promise<{ tool?: string[] }>;
  searchParams: Promise<{ preset?: string | string[] }>;
}) {
  const [{ tool }, { preset: presetId }] = await Promise.all([params, searchParams]);
  if (!studioAvailable() || (tool && (tool.length !== 1 || !findStudioTool(tool[0])))) notFound();
  const preset = STUDIO_PHOTO_PRESETS.find(item => item.tool === tool?.[0] && item.id === presetId);
  return <StudioWorkspace key={[tool?.[0] ?? "directory", preset?.id].join("/")} toolId={tool?.[0]} preset={preset} />;
}
