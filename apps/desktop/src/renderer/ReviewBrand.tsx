import { getModelBrand } from "../../../../lib/modelBranding";

const brandIcons = import.meta.glob<string>("../../../../public/model-icons/*.png", { eager: true, import: "default", query: "?url&no-inline" });

/** The provider's logo as the web model picker shows it, or its short mark where there is no image. */
export function BrandMark({ provider, large = false }: { provider: string; large?: boolean }) {
  const brand = getModelBrand(provider);
  const source = brand.image && brandIcons[`../../../../public${brand.image}`];
  return <span className={large ? "review-chip-logo review-chip-logo--large" : "review-chip-logo"} aria-hidden="true">
    {source ? <img src={source} alt="" draggable={false} /> : brand.mark}
  </span>;
}
