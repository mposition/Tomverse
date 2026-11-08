"use client";

import Link from "next/link";
import { useModelCatalog } from "@/components/ModelCatalogProvider";
import { canUseModelWithPlan, type ModelTier } from "@/lib/models";
import { chatWorkspaceGuideHref } from "@/lib/localizedHelpHref";

export function PricingPlanCapabilities({ plan }: { plan: ModelTier }) {
  const { publicModels } = useModelCatalog();
  const models = publicModels.filter((model) => model.enabled && canUseModelWithPlan(plan, model));

  return (
    <details className="mt-5 text-sm leading-6" data-testid={`pricing-capabilities-${plan.toLowerCase()}`}>
      <summary className="cursor-pointer font-bold underline underline-offset-4">View supported models and file limits</summary>
      <div className="mt-3 space-y-3">
        <p>Where attachments are enabled for signed-in {plan} accounts: up to 5 files per message, 10 MiB per file and 25 MiB combined. Google Drive requires sign-in.</p>
        <p>Model context ceilings are listed in tokens below. The app’s input limit and available output space can reduce usable context; a plan does not guarantee the full model window. Check current availability in the model selector.</p>
        <ul className="list-inside list-disc space-y-1">
          {models.map((model) => (
            <li key={model.id} data-model-id={model.id}>
              {model.name} — {model.contextWindowTokens ? `${model.contextWindowTokens.toLocaleString("en-US")} tokens` : "context ceiling not listed"}
            </li>
          ))}
        </ul>
        <Link href="/models" className="block font-bold underline underline-offset-4">Compare model access and base credits</Link>
        <Link href={chatWorkspaceGuideHref("en", "files-and-drive")} className="block font-bold underline underline-offset-4">File limits and Google Drive help</Link>
      </div>
    </details>
  );
}
