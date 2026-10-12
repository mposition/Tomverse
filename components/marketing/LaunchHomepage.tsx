"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useLanguage } from "@/components/LanguageProvider";
import { trackProductEvent } from "@/lib/productAnalyticsClient";
import { localizedPath } from "@/lib/seo";
import { MarketingFooter, MarketingHeader } from "./MarketingChrome";
import { useMarketingChatEntry } from "./MarketingChatAvailability";
import { launchAccountEntryCopy, launchHomepageContent, launchReviewEntryCopy, type EverydayExample, type LaunchHomepageCopy } from "./launchHomepageContent";
import styles from "./LaunchHomepage.module.css";

type LaunchHomepageProps = { reviewInfoHref: string };
const modelNames = ["GPT", "Claude", "Gemini"] as const;
const answerIds = ["A", "B", "C"] as const;
const exampleIds = ["travel", "learn", "write"] as const;

function ActionLink({ href, children, inverse = false, subtle = false, id, testId, location }: {
  href: string; children: ReactNode; inverse?: boolean; subtle?: boolean;
  id?: string; testId?: string; location?: string;
}) {
  return <Link href={href} id={id} data-testid={testId}
    className={`${styles.action} ${inverse ? styles.inverseAction : subtle ? styles.subtleAction : ""}`}
    onClick={location ? () => trackProductEvent("cta_start_click", 0, { cta_location: location }) : undefined}>
    <span>{children}</span><span aria-hidden="true">↗</span>
  </Link>;
}

function Lines({ lines }: { lines: [string, string] }) {
  return <>{lines.map((line, i) => <span key={i}>{line}</span>)}</>;
}

function HeroPreview({ copy, motionLabel, motionDisabled, onMotionToggle }: {
  copy: LaunchHomepageCopy["hero"]; motionLabel: string; motionDisabled: boolean; onMotionToggle: () => void;
}) {
  return <figure className={styles.heroFigure} aria-label="Tomverse Chat">
    <div className={styles.modelArt}>
      <div className={styles.rails} aria-hidden="true">
        <Image src="/marketing/launch/convergence-rails.svg" alt="" width={660} height={340} loading="eager" unoptimized />
      </div>
      <span className={styles.oneSculpture} aria-hidden="true">ONE</span>
      <div className={styles.modelStamps} aria-hidden="true">
        {modelNames.map((model, i) => <div key={model} className={`${styles.modelStamp} ${styles[`stamp${i}`]}`}>
          <strong>{model}</strong><span>{copy.modelNote}</span>
        </div>)}
      </div>
      <div className={styles.chatPreview}>
        <div className={styles.chatPreviewHeader}><strong>Tomverse Chat</strong><span>Smart Adaptive</span></div>
        <p className={styles.previewQuestion}>{copy.question}</p>
        <h2>{copy.responseTitle}</h2>
        <p className={styles.previewBody}>{copy.responseBody}</p>
        <p className={styles.previewFollowup}>{copy.followup} <span aria-hidden="true">↗</span></p>
      </div>
    </div>
    <figcaption className={styles.heroDemo}>
      <span>{copy.demo}</span>
      <button type="button" className={styles.motionToggle} aria-pressed={motionDisabled}
        data-testid="launch-motion-toggle" onClick={onMotionToggle}>{motionLabel}</button>
    </figcaption>
  </figure>;
}

function ExampleResult({ example, index }: { example: EverydayExample; index: number }) {
  return <div className={styles.exampleResult}>
    <p className={styles.resultType}>{example.type}</p>
    <h3>{example.title}</h3>
    <p className={styles.resultIntro}>{example.intro}</p>
    <div className={styles.resultRows}>
      {example.rows.map((row, i) => <div key={i}
        className={`${styles.resultRow} ${index === 2 ? styles.messageRow : ""} ${index === 2 && i === 1 ? styles.refinedMessage : ""}`}>
        <p className={styles.rowLabel}>{row.label}</p>
        <div><h4>{row.title}</h4>{row.body && <p>{row.body}</p>}</div>
      </div>)}
    </div>
    <div className={styles.resultFollowup}><h4>{example.followupTitle}</h4><p>{example.followup}</p></div>
  </div>;
}

function EverydayGallery({ copy }: { copy: LaunchHomepageCopy["gallery"] }) {
  const [selected, setSelected] = useState(0);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const galleryId = useId();
  const selectWithKeyboard = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % 3;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index + 2) % 3;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = 2;
    else return;
    event.preventDefault();
    setSelected(next);
    tabs.current[next]?.focus();
  };
  return <section className={`${styles.section} ${styles.gallerySection}`} aria-labelledby="launch-everyday-title">
    <div className={styles.container}>
      <h2 id="launch-everyday-title" className={styles.galleryHeading}><Lines lines={copy.title} /></h2>
      <p className={styles.galleryIntro}>{copy.body}</p>
      <div className={styles.gallery} data-testid="launch-gallery">
        <div className={styles.galleryNavigation}>
          <h3>{copy.navTitle}</h3><p className={styles.galleryHelp}>{copy.navBody}</p>
          <div role="tablist" aria-label={copy.navTitle} className={styles.galleryTabs}>
            {copy.examples.map((example, i) => <button key={exampleIds[i]} type="button" role="tab"
              ref={(element) => { tabs.current[i] = element; }}
              id={`${galleryId}-${exampleIds[i]}-tab`} aria-controls={`${galleryId}-${exampleIds[i]}-panel`}
              aria-selected={selected === i} tabIndex={selected === i ? 0 : -1}
              data-testid={`launch-gallery-tab-${exampleIds[i]}`}
              onClick={() => setSelected(i)} onKeyDown={(event) => selectWithKeyboard(event, i)}>
              <span>{example.label}</span><span className={styles.tabDescription}>{example.description}</span>
            </button>)}
          </div>
          <div className={styles.exampleQuestion}><span>{copy.questionLabel}</span><p>{copy.examples[selected].question}</p></div>
        </div>
        <div className={styles.galleryPanels}>
          {copy.examples.map((example, i) => <div key={exampleIds[i]} role="tabpanel"
            id={`${galleryId}-${exampleIds[i]}-panel`} aria-labelledby={`${galleryId}-${exampleIds[i]}-tab`}
            hidden={selected !== i} tabIndex={0} data-testid={`launch-gallery-panel-${exampleIds[i]}`}>
            <ExampleResult example={example} index={i} />
          </div>)}
        </div>
      </div>
      <p className={styles.smallNote}>{copy.demo}</p>
    </div>
  </section>;
}

export default function LaunchHomepage({ reviewInfoHref }: LaunchHomepageProps) {
  const { lang } = useLanguage();
  const copy = launchHomepageContent[lang];
  const { chatAvailable, guestTrialAvailable, isAuthenticated, chatHref, reviewHref: reviewEntryHref, primaryHref, primaryProduct } = useMarketingChatEntry();
  const reviewEntryCopy = launchReviewEntryCopy[lang];
  const accountCopy = isAuthenticated && chatAvailable ? launchAccountEntryCopy[lang] : null;
  const isGuestChatTrial = !isAuthenticated && guestTrialAvailable;
  const [motionDisabled, setMotionDisabled] = useState(false);
  const landingTracked = useRef(false);
  useEffect(() => {
    if (landingTracked.current) return;
    landingTracked.current = true;
    trackProductEvent("landing_view");
  }, []);

  return <div className={styles.homepage} lang={lang} data-testid="launch-homepage" data-motion-disabled={motionDisabled}
    data-guest-chat-trial-available={guestTrialAvailable ? "true" : "false"}>
    <div className={styles.heroStage}>
      <MarketingHeader variant="launch" maxWidth="max-w-[1440px]" chatHref={chatHref} reviewInfoHref={reviewInfoHref} />
      <main>
        <section className={styles.hero} aria-labelledby="landing-hero-title">
          <div className={styles.container}>
            <h1 id="landing-hero-title" data-testid="landing-hero-title" className={styles.heroTitle}><Lines lines={copy.hero.title} /></h1>
            <div className={styles.heroContent}>
              <div className={styles.heroStory}>
                <p>{copy.hero.body}</p>
                <div className={styles.actions}>
                  <ActionLink href={primaryHref} id="landing-hero-primary" testId="landing-primary-cta" location={`landing_hero_${primaryProduct}`}>{copy.actions[primaryProduct]}</ActionLink>
                  <ActionLink href={reviewInfoHref} inverse testId="launch-review-info-cta">{copy.actions.reviewInfo}</ActionLink>
                </div>
                <p className={styles.heroAccess} data-testid="landing-hero-signup-note">{accountCopy?.heroAccess ?? (isGuestChatTrial ? copy.hero.access : reviewEntryCopy.heroAccess)}</p>
              </div>
              <HeroPreview copy={copy.hero} motionDisabled={motionDisabled}
                motionLabel={motionDisabled ? copy.actions.motionOn : copy.actions.motionOff}
                onMotionToggle={() => setMotionDisabled(current => !current)} />
            </div>
          </div>
          <div className={styles.ribbonWrap} aria-hidden="true"><div className={styles.ribbon}>
            <span>MANY AIs.</span><span>ONE Tomverse.</span><span>MANY AIs.</span><span>ONE Tomverse.</span>
          </div></div>
        </section>

        <section id="chat" className={`${styles.section} ${styles.adaptiveSection}`} aria-labelledby="launch-adaptive-title">
          <div className={styles.container}>
            <div className={styles.adaptiveIntroduction}>
              <div><p className={styles.eyebrow}>Smart Adaptive</p><h2 id="launch-adaptive-title" className={styles.sectionHeading}><Lines lines={copy.adaptive.title} /></h2></div>
              <div className={styles.adaptiveExplanation}><p>{copy.adaptive.body}</p><strong>{copy.adaptive.emphasis}</strong></div>
            </div>
            <div className={styles.adaptiveSurface}>
              <div className={styles.refinement}>
                <p className={styles.originalQuestion}>{copy.adaptive.original}</p>
                <p className={styles.refinerLabel}>{copy.adaptive.refiner}</p>
                <p className={styles.refinedQuestion}>{copy.adaptive.refined}</p>
              </div>
              <div className={styles.modelSelection}>
                <h3>{copy.adaptive.selectionTitle}</h3>
                <div>{copy.adaptive.criteria.map((criterion) => <p key={criterion}>{criterion}</p>)}</div>
                <div className={styles.selectionOutcome}>{copy.adaptive.outcome.map((line) => <p key={line}>{line}</p>)}</div>
              </div>
            </div>
            <p className={styles.smallNote}>{copy.adaptive.note}</p>
          </div>
        </section>

        <EverydayGallery copy={copy.gallery} />

        <section id="how-it-works" className={`${styles.section} ${styles.reviewSection}`} aria-labelledby="launch-review-title">
          <div className={styles.container}>
            <p className={styles.eyebrow}>Tomverse Review</p>
            <h2 id="launch-review-title" className={styles.reviewHeading}><Lines lines={copy.review.title} /></h2>
            <p className={styles.reviewIntro}>{copy.review.body}</p>
            <div className={styles.reviewSurface}>
              <h3 className={styles.reviewQuestion}>{copy.review.question}</h3>
              <div className={styles.answerGrid}>{copy.review.answers.map((answer, i) => <article key={answerIds[i]}>
                <div className={styles.answer}><p className={styles.answerModel}>{answerIds[i]}</p><h4>{answer.title}</h4><p>{answer.body}</p></div>
                <p className={styles.answerQuote}>“{answer.quote}” · {answerIds[i]}</p>
              </article>)}</div>
              <div className={styles.aiReview}>
                <div><p className={styles.aiReviewLabel}>AI Review</p><h3>{copy.review.synthesisTitle}</h3></div>
                <dl>{copy.review.findings.map((finding) => <div key={finding.label}><dt>{finding.label}</dt><dd>{finding.body}</dd></div>)}</dl>
              </div>
              <div className={styles.aiReviewRail} aria-hidden="true" />
            </div>
            <div className={styles.reviewActions}>
              <ActionLink href={reviewInfoHref} inverse testId="launch-review-details">{copy.actions.reviewInfo}</ActionLink>
              <ActionLink href={reviewEntryHref} testId="launch-review-start">{copy.actions.review}</ActionLink>
              <p className={styles.smallNote}>{copy.review.note}</p>
            </div>
          </div>
        </section>

        <section className={`${styles.section} ${styles.toolsSection}`} aria-labelledby="launch-tools-title">
          <div className={styles.container}>
            <h2 id="launch-tools-title" className={styles.toolsHeading}><Lines lines={copy.tools.title} /></h2>
            <div className={styles.toolsColumns}>{copy.tools.columns.map((tool) => <div key={tool.title}><h3>{tool.title}</h3><p>{tool.body}</p><p className={styles.toolExample}>{tool.label}</p></div>)}</div>
            <p className={styles.smallNote}>{copy.tools.note}</p>
          </div>
        </section>

        <section id="trust" className={`${styles.section} ${styles.plansSection}`} aria-labelledby="launch-plans-title">
          <div className={styles.container}>
            <div className={styles.plansGrid}>
              <div><p className={styles.eyebrow}>Free · Pro · Max</p><h2 id="launch-plans-title">{copy.plans.title}</h2><p>{accountCopy?.plansBody ?? (isGuestChatTrial ? copy.plans.body : reviewEntryCopy.plansBody)}</p><ActionLink href={localizedPath(lang, "/pricing")} subtle>{copy.actions.pricing}</ActionLink></div>
              <div className={styles.trustCopy}><h3>{copy.plans.trustTitle}</h3><p>{copy.plans.trustBody}</p><Link href={localizedPath(lang, "/safety")} className={styles.textLink}>{copy.actions.safety} <span aria-hidden="true">↗</span></Link></div>
            </div>
          </div>
        </section>

        <section className={styles.guestSection} aria-labelledby="launch-guest-title">
          <div className={`${styles.container} ${styles.guestGrid}`}>
            <div><h2 id="launch-guest-title">{accountCopy?.guestTitle ?? copy.guest.title}</h2><p>{accountCopy?.guestBody ?? (isGuestChatTrial ? copy.guest.body : reviewEntryCopy.guestBody)}</p></div>
            <div className={styles.actions}><ActionLink href={chatHref} inverse location="landing_final_chat">{chatAvailable ? copy.actions.chat : reviewEntryCopy.chatInfo}</ActionLink><ActionLink href={reviewEntryHref} inverse>{copy.actions.review}</ActionLink></div>
          </div>
        </section>
      </main>
    </div>
    <MarketingFooter variant="launch" maxWidth="max-w-[1440px]" />
  </div>;
}
