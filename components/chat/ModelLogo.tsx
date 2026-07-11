import type { AiModel, AiProvider } from "@/lib/models";
import { getModelBrand } from "@/lib/modelBranding";

type ModelLogoSize = "xs" | "sm" | "md" | "lg";

type ModelLogoProps = {
  model?: Pick<AiModel, "name" | "provider" | "icon"> | null;
  provider?: AiProvider | string;
  size?: ModelLogoSize;
  className?: string;
};

const frameSize: Record<ModelLogoSize, string> = {
  xs: "h-5 w-5 rounded-full",
  sm: "h-6 w-6 rounded-lg",
  md: "h-8 w-8 rounded-lg",
  lg: "h-11 w-11 rounded-xl",
};

const imageSize: Record<ModelLogoSize, string> = {
  xs: "h-3.5 w-3.5",
  sm: "h-4 w-4",
  md: "h-5 w-5",
  lg: "h-7 w-7",
};

export function ModelLogo({
  model,
  provider,
  size = "md",
  className = "",
}: ModelLogoProps) {
  const resolvedProvider = model?.provider || provider || "ai";
  const brand = getModelBrand(resolvedProvider);
  const label = model?.name || resolvedProvider;

  return (
    <span
      className={`flex shrink-0 items-center justify-center bg-gradient-to-br text-[10px] font-black text-zinc-700 ring-1 ring-zinc-200 dark:ring-zinc-700 ${frameSize[size]} ${brand.className} ${className}`}
      aria-hidden="true"
      title={label}
    >
      {brand.image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={brand.image}
          alt=""
          className={`${imageSize[size]} object-contain`}
          draggable={false}
        />
      ) : (
        <span className="scale-90 truncate px-0.5 text-white">{model?.icon || brand.mark}</span>
      )}
    </span>
  );
}
