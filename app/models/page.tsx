import { ModelsPageContent } from "@/components/marketing/ModelsPageContent";
import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: "Available AI Models",
  description:
    "Explore the AI models available in Tomverse, their providers, access tiers, and current public service status.",
  path: "/models",
});

export default function ModelsPage() {
  return <ModelsPageContent />;
}
