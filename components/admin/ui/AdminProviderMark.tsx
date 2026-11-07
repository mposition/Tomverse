import Image from "next/image";
import { getModelBrand } from "@/lib/modelBranding";

/**
 * An AI provider's logo from `public/model-icons`, or its letter mark when it
 * has none. Decorative: the provider's name is always written beside it.
 */
export function AdminProviderMark({
  provider,
  size = 24,
  className = "",
}: {
  provider: string;
  size?: number;
  className?: string;
}) {
  const brand = getModelBrand(provider);
  if (brand.image) {
    return (
      <Image
        src={brand.image}
        alt=""
        aria-hidden
        width={size}
        height={size}
        unoptimized
        className={`shrink-0 rounded-md object-contain ${className}`}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center rounded-md bg-zinc-800 text-[10px] font-bold text-zinc-300 ${className}`}
      style={{ width: size, height: size }}
    >
      {brand.mark.slice(0, 2)}
    </span>
  );
}
