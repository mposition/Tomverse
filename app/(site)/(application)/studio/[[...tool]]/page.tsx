import { notFound } from "next/navigation";
import { StudioWorkspace } from "@/components/studio/StudioWorkspace";
import { studioAvailable } from "@/lib/studioAvailability";
import { findStudioTool } from "@/lib/studioTools";

export const metadata = { title: "Tomverse Studio" };

export default async function StudioPage({ params }: { params: Promise<{ tool?: string[] }> }) {
  const { tool } = await params;
  if (!studioAvailable() || (tool && (tool.length !== 1 || !findStudioTool(tool[0])))) notFound();
  return <StudioWorkspace key={tool?.[0] ?? "directory"} toolId={tool?.[0]} />;
}
