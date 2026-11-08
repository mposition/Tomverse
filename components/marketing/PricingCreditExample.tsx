"use client";

import Link from "next/link";
import { useModelCatalog } from "@/components/ModelCatalogProvider";
import { DEFAULT_MODEL_ID, getModelUsageProfile } from "@/lib/models";

export function PricingCreditExample({ credits, testId }: { credits: number; testId: string }) {
  const { publicModels } = useModelCatalog();
  const model = publicModels.find((item) => item.id === DEFAULT_MODEL_ID && item.enabled);
  const baseCredits = model ? getModelUsageProfile(model).credits : null;
  const format = (value: number) => value.toLocaleString("en-US");

  return (
    <div data-testid={testId} className="mt-4 space-y-2 text-sm leading-6">
      <Link href="/models" className="font-bold underline underline-offset-4">Model-by-model credit costs</Link>
      {model && baseCredits ? (
        <>
          <p>{format(credits)} credits cover up to {format(Math.floor(credits / baseCredits))} short text requests with {model.name} at {format(baseCredits)} base {baseCredits === 1 ? "credit" : "credits"} per request.</p>
          <p>Illustration only: manually selected model, up to 16,000 input tokens, no files, tools or long history, and no other credit use. Actual usage can vary.</p>
        </>
      ) : null}
    </div>
  );
}
