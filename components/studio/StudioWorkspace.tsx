"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowRight } from "lucide-react";
import { ReviewNavigation, WorkspaceTitle, WorkspaceThemeButton } from "@/components/chat/ReviewStudioChrome";
import { AppToastViewport } from "@/components/AppToastViewport";
import { purchaseCtaCopy } from "@/components/billing/purchaseCopy";
import { notifyUserUsageChanged } from "@/components/chat/useUserUsage";
import { useLanguage } from "@/components/LanguageProvider";
import { trackProductEvent } from "@/lib/productAnalyticsClient";
import { normalizeCreditPackId, normalizePurchaseTargetPlan } from "@/lib/purchaseIntent";
import { PRODUCT_SURFACE_PATH } from "@/lib/productSurfaceRoutes";
import { STUDIO_TOOLS, findStudioTool, studioArtworkPath, type StudioPhotoPreset, type StudioTool } from "@/lib/studioTools";
import { StudioStickerTool } from "./StudioStickerTool";
import { StudioToolEditor } from "./StudioToolEditor";
import { StudioCreativeEditor } from "./StudioCreativeEditor";
import { StudioPresetGallery } from "./StudioPresetGallery";
import { useStudioCopy } from "./StudioControls";
import "@/components/chat/review-studio.css";
import styles from "./studio.module.css";

const StudioAccount = dynamic(() => import("@/components/auth/AuthButton").then(module => module.AuthButton));

type StudioBillingOutcome = "success" | "cancelled" | "credits-success" | "credits-cancelled" | "tester-pass";

function ToolArtwork({ tool }: { tool: StudioTool }) {
  if (tool.id === "stickers") {
    return <div className={styles.stickerMosaic}>
      {[2, 3, 1].map(number => <Image key={number} src={`/studio/sticker-${number}.png`} alt="" width={90} height={90} unoptimized />)}
    </div>;
  }
  if (tool.id === "transparent-png") {
    return <div className={styles.cutoutMosaic}><Image src="/studio/cat.png" alt="" width={129} height={166} unoptimized /></div>;
  }
  const analysis = tool.id === "face-analysis" || tool.id === "color-analysis" ? tool.id : undefined;
  return <picture className={styles.cardPhoto} data-analysis={analysis}>
    <img src={studioArtworkPath(tool.artwork)} alt="" width={294} height={172} data-character={tool.id === "character-maker" || undefined} />
  </picture>;
}

export function StudioWorkspace({ toolId, preset }: { toolId?: string; preset?: StudioPhotoPreset }) {
  const { copy, lang } = useStudioCopy();
  const { t } = useLanguage();
  const router = useRouter();
  const [billingOutcome, setBillingOutcome] = useState<StudioBillingOutcome>();
  const billingMessages = {
    success: t("billing.paymentSuccessfulTitle"),
    "tester-pass": t("billing.testerPassActivatedTitle"),
    cancelled: purchaseCtaCopy[lang].purchaseCancelledTitle,
    "credits-success": purchaseCtaCopy[lang].purchaseSuccessTitle,
    "credits-cancelled": purchaseCtaCopy[lang].purchaseCancelledTitle,
  };
  const billingNotice = billingOutcome ? billingMessages[billingOutcome] : undefined;

  useEffect(() => {
    const url = new URL(window.location.href);
    const billing = url.searchParams.get("billing");
    if (billing !== "success" && billing !== "cancelled" &&
        billing !== "credits-success" && billing !== "credits-cancelled") return;
    const outcome = billing === "success" && url.searchParams.get("access") === "founding-tester-pass"
      ? "tester-pass" : billing;
    const purchased = billing === "success" || billing === "credits-success";
    const pack = normalizeCreditPackId(url.searchParams.get("pack"));
    const plan = normalizePurchaseTargetPlan(url.searchParams.get("plan"));

    for (const key of ["billing", "pack", "plan", "interval", "access"]) url.searchParams.delete(key);
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);

    queueMicrotask(() => {
      setBillingOutcome(outcome);
      if (purchased) notifyUserUsageChanged();
      else trackProductEvent("checkout_cancelled", 0, {
        cta_location: "studio_checkout_return",
        purchase_type: billing === "credits-cancelled" ? "credit_pack" : "subscription",
        ...(pack ? { pack_id: pack } : {}),
        ...(plan ? { target_plan: plan } : {}),
      });
    });
  }, []);
  const studioPath = PRODUCT_SURFACE_PATH.studio;
  const tool = toolId ? findStudioTool(toolId) : undefined;
  return <div className={styles.shell} lang={lang} data-testid="studio-workspace">
    <ReviewNavigation product="studio" onNewChat={() => router.push(`/chat?lang=${lang}`)}
      sidebar={<aside className={styles.history}>
        <Link href={{ pathname: "/chat", query: { lang } }}>{copy.openHistory}</Link>
        <StudioAccount currentProduct="studio" showAnalyticsCookieButton />
      </aside>} />
    <main className={styles.main}>
      <header className={"review-command-bar " + styles.commandBar} data-testid="studio-command-bar">
        <WorkspaceTitle name="Studio" caption={copy.workspaceCaption} title={tool ? copy[tool.title] : undefined}
          href={tool ? { pathname: studioPath, query: { lang } } : undefined} />
        <WorkspaceThemeButton />
      </header>
      {billingNotice && <p className={styles.billingNotice} role="status" data-testid="studio-billing-notice">{billingNotice}</p>}
      {tool ? <>
        <h1 className="sr-only">{copy[tool.title]}</h1>
        <p className={styles.toolIntro}>{copy[tool.description]}</p>
        {tool.id === "stickers" ? <StudioStickerTool billingNotice={billingNotice} />
          : tool.id === "character-maker" || tool.id === "face-analysis" || tool.id === "color-analysis"
            ? <StudioCreativeEditor tool={tool} />
            : <StudioToolEditor tool={tool} preset={preset} />}
      </> : <>
        <section className={styles.studioHero}>
          <div className={styles.heroCopy}>
            <h1 className="type-display">{copy.heroTitle}</h1>
            <p>{copy.directoryIntro}</p>
            <div className={styles.heroLinks}>
              <a href="#studio-tools-design">{copy.browsePresets}<ArrowDown size={17} aria-hidden /></a>
              <a href="#studio-tools-publishing">{copy.posterGroup}<ArrowDown size={17} aria-hidden /></a>
            </div>
          </div>
          <div className={styles.heroExhibits}>
            <Link className={styles.heroFilm} aria-label={copy.filmPortrait}
              href={{ pathname: `${studioPath}/illustration`, query: { lang, preset: "film" } }}>
              <Image src="/studio/preset-film.webp" width={260} height={260} alt="" unoptimized />
            </Link>
            <Link className={styles.heroPoster} aria-label={copy.posterMakerTitle} href={{ pathname: `${studioPath}/poster`, query: { lang } }}>
              <Image src="/studio/poster-jazz.webp" width={280} height={348} alt="" unoptimized />
            </Link>
            <Link className={styles.heroCharacter} aria-label={copy.characterMakerTitle} href={{ pathname: `${studioPath}/character-maker`, query: { lang } }}>
              <Image src="/studio/character-fantasy.webp" width={330} height={330} alt="" unoptimized />
            </Link>
            <Link className={styles.heroSticker} aria-label={copy.stickersTitle} href={{ pathname: `${studioPath}/stickers`, query: { lang } }}>
              <Image src="/studio/sticker-3.png" width={142} height={142} alt="" unoptimized />
            </Link>
          </div>
        </section>
        {(["play", "design", "publishing"] as const).map(group => (
          <section key={group} className={styles.directorySection} aria-labelledby={`studio-tools-${group}`}>
            <h2 id={`studio-tools-${group}`}>{group === "play" ? copy.playGroup : group === "design" ? copy.designGroup : copy.posterGroup}</h2>
            {group === "design" ? <StudioPresetGallery studioPath={studioPath} /> : <ul className={styles.directoryGrid}
              data-play={group === "play" || undefined} data-publishing={group === "publishing" || undefined}>
              {STUDIO_TOOLS.filter(item => item.group === group).map(item => (
                <li key={item.id}>
                  <Link className={styles.toolCard} href={{ pathname: `${studioPath}/${item.id}`, query: { lang } }} data-testid={`studio-tool-${item.id}`}>
                    <div className={styles.cardArt}><ToolArtwork tool={item} /></div>
                    <div className={styles.cardCopy}>
                      <h3>{copy[item.title]}</h3><ArrowRight size={17} aria-hidden />
                      <p className={styles.desktopCopy}>{copy[item.description]}</p><p className={styles.mobileCopy}>{copy[item.mobileDescription]}</p>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>}
          </section>
        ))}
      </>}
    </main>
    <AppToastViewport />
  </div>;
}
