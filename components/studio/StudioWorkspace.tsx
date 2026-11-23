"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { ReviewNavigation } from "@/components/chat/ReviewStudioChrome";
import { MarketingConsentSlot } from "@/components/analytics/AnalyticsProvider";
import { PRODUCT_SURFACE_PATH } from "@/lib/productSurfaceRoutes";
import { STUDIO_TOOLS, findStudioTool, type StudioTool } from "@/lib/studioTools";
import { StudioStickerTool } from "./StudioStickerTool";
import { StudioToolEditor } from "./StudioToolEditor";
import { useStudioCopy } from "./StudioControls";
import "@/components/chat/review-studio.css";
import styles from "./studio.module.css";

const mobileArtwork = new Set(["meme", "illustration", "caricature", "poster"]);

function ToolArtwork({ tool }: { tool: StudioTool }) {
  if (tool.id === "stickers") {
    return <div className={styles.stickerMosaic}>
      {[2, 3, 1].map(number => <Image key={number} src={`/studio/sticker-${number}.png`} alt="" width={90} height={90} unoptimized />)}
    </div>;
  }
  if (tool.id === "transparent-png") {
    return <div className={styles.cutoutMosaic}><Image src="/studio/cat.png" alt="" width={129} height={166} unoptimized /></div>;
  }
  return <picture className={styles.cardPhoto}>
    {mobileArtwork.has(tool.artwork) && <source media="(max-width: 767px)" srcSet={`/studio/${tool.artwork}-mobile.png`} />}
    {/* Art direction differs between desktop and mobile. */}
    <img src={`/studio/${tool.artwork}.png`} alt="" width={294} height={172} />
  </picture>;
}

export function StudioWorkspace({ toolId }: { toolId?: string }) {
  const { copy, lang } = useStudioCopy();
  const router = useRouter();
  const studioPath = PRODUCT_SURFACE_PATH.studio;
  const tool = toolId ? findStudioTool(toolId) : undefined;
  return <div className={styles.shell} lang={lang} data-testid="studio-workspace">
    <ReviewNavigation product="studio" onNewChat={() => router.push(`/chat?lang=${lang}`)}
      sidebar={<div className={styles.history}><Link href={{ pathname: "/chat", query: { lang } }}>{copy.openHistory}</Link></div>} />
    <main className={styles.main}>
      {tool ? <>
        <Link className={styles.back} href={{ pathname: studioPath, query: { lang } }}><ArrowLeft size={16} aria-hidden />Studio</Link>
        <header className={styles.toolHeader}>
          <h1>{copy[tool.title]}</h1><p>{copy[tool.description]}</p>
        </header>
        <MarketingConsentSlot />
        {tool.id === "stickers" ? <StudioStickerTool /> : <StudioToolEditor tool={tool} />}
      </> : <>
        <header className={styles.directoryHeader}>
          <h1>Studio</h1><p>{copy.directoryIntro}</p>
        </header>
        <MarketingConsentSlot />
        {(["play", "design"] as const).map(group => (
          <section key={group} className={styles.directorySection} aria-labelledby={`studio-tools-${group}`}>
            <h2 id={`studio-tools-${group}`}>{group === "play" ? copy.playGroup : copy.designGroup}</h2>
            <ul className={styles.directoryGrid}>
              {STUDIO_TOOLS.filter(item => item.group === group).map(item => (
                <li key={item.id}>
                  <Link className={styles.toolCard} href={{ pathname: `${studioPath}/${item.id}`, query: { lang } }} data-testid={`studio-tool-${item.id}`}>
                    <div className={styles.cardArt}><ToolArtwork tool={item} /></div>
                    <div className={styles.cardCopy}>
                      <h3>{"shortTitle" in item ? <><span className={styles.desktopCopy}>{copy[item.title]}</span><span className={styles.mobileCopy}>{copy[item.shortTitle]}</span></> : copy[item.title]}</h3><ArrowRight size={17} aria-hidden />
                      <p className={styles.desktopCopy}>{copy[item.description]}</p><p className={styles.mobileCopy}>{copy[item.mobileDescription]}</p>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </>}
    </main>
  </div>;
}
