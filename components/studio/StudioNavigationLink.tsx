"use client";

import Image from "next/image";
import Link from "next/link";
import { useLanguage } from "@/components/LanguageProvider";
import { PRODUCT_SURFACE_PATH } from "@/lib/productSurfaceRoutes";
import { useStudioAvailable } from "./StudioAvailability";

export function StudioNavigationLink({ active = false, locked = false, compact = false }: {
  active?: boolean;
  locked?: boolean;
  compact?: boolean;
}) {
  const enabled = useStudioAvailable();
  const { lang } = useLanguage();
  if (!enabled) return null;
  return (
    <Link
      href={{ pathname: PRODUCT_SURFACE_PATH.studio, query: { lang } }}
      className={compact ? undefined : "review-navigation-studio"}
      data-testid={compact ? "plugin-menu-studio" : "navigation-studio"}
      aria-current={active ? "page" : undefined}
      aria-disabled={locked || undefined}
      onClick={event => { if (locked) event.preventDefault(); }}
    >
      {!compact && <Image src="/studio/brush.svg" width={22} height={22} unoptimized alt="" aria-hidden="true" />}
      <span>Studio</span>
    </Link>
  );
}
