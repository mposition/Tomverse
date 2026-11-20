"use client";

import { useState, type ReactNode } from "react";
import { MODEL_USAGE_CREDIT_WEIGHTS } from "@/lib/models";
import { WEB_SEARCH_SURCHARGE_CREDITS } from "@/lib/webSearchCredits";
import { CALCULATOR_BANDS as BANDS, CALCULATOR_TIERS as TIERS, calculateSend, requestsPerMonth, type CalculatorTier as Tier } from "./creditCalculatorMath";
import type { PricingPageCopy } from "./pricingPageContent";

const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));

/**
 * How many requests each plan's monthly credits cover for the models and input length picked.
 * Every number comes from the code that charges them: the tier weights and the input
 * multipliers in lib/models.ts and the flat web search surcharge in lib/webSearchCredits.ts.
 */
export function CreditCalculator({ copy, plans, numberFormat, formatCredits, longContextNote, inputLimitNote, higherNote }: {
  copy: PricingPageCopy["calc"];
  plans: ReadonlyArray<{ id: string; name: string; monthlyCredits: number }>;
  numberFormat: Intl.NumberFormat;
  /** A credit amount with its unit ("8 credits"). */
  formatCredits: (count: number) => string;
  /** The configured input ceiling's note, or null while long context is off. */
  longContextNote: string | null;
  /** The configured input ceiling, shown while long context is off, or null. */
  inputLimitNote: string | null;
  /** The sentence about higher categories, with its models-page link already filled in. */
  higherNote: ReactNode;
}) {
  const [picked, setPicked] = useState<Record<Tier, boolean>>({ standard: true, advanced: false, premium: false });
  const [band, setBand] = useState(0);
  const [web, setWeb] = useState(false);
  const chosen = TIERS.filter((tier) => picked[tier]);
  const multiplier = BANDS[band].multiplier;
  const { models, searchCredits, perSend } = calculateSend(chosen, band, web);
  const counts = plans.map((plan) => ({ ...plan, requests: requestsPerMonth(plan.monthlyCredits, perSend) }));
  const largest = Math.max(1, ...counts.map((plan) => plan.requests));
  // The unit word as it agrees with the amount ("credit" for one, "credits" otherwise).
  const creditUnit = formatCredits(perSend).replace(numberFormat.format(perSend), "").trim();
  const kilo = (tokens: number) => numberFormat.format(tokens / 1000);
  const bandName = (index: number) => index === 0
    ? `${copy.ctxShort} · ${numberFormat.format(1)}×`
    : `${fill(copy.ctxOver, { k: kilo(BANDS[index].aboveTokens) })} · ${numberFormat.format(BANDS[index].multiplier)}×`;
  const toggle = (tier: Tier) => {
    // At least one model stays picked, so a send always costs something.
    if (picked[tier] && chosen.length === 1) return;
    setPicked({ ...picked, [tier]: !picked[tier] });
  };
  return <div className="calc">
    <div className="panel">
      <p className="muted calc-pick">{copy.pick}</p>
      <div className="tier-pick">
        {TIERS.map((tier, index) => <label key={tier}>
          <input type="checkbox" checked={picked[tier]} onChange={() => toggle(tier)} data-testid={`pricing-calc-tier-${tier}`} />
          <span>{copy.tiers[index][0]}<small>{copy.tiers[index][1]}</small></span>
          <span className="chip">{numberFormat.format(MODEL_USAGE_CREDIT_WEIGHTS[tier])}</span>
        </label>)}
      </div>
      <div className="ctx">
        <p className="muted calc-pick"><label htmlFor="pricing-calc-ctx">{copy.ctxLabel}</label> <b data-testid="pricing-calc-ctx-name">{bandName(band)}</b></p>
        <input id="pricing-calc-ctx" type="range" min={0} max={BANDS.length - 1} step={1} value={band}
          aria-label={copy.ctxAria} aria-valuetext={bandName(band)} onChange={(event) => setBand(Number(event.target.value))} />
        <div className="ctx-labels" aria-hidden="true">
          {BANDS.map((item, index) => <span key={item.aboveTokens}>{index === 0 ? `≤${kilo(BANDS[1].aboveTokens)}K` : `>${kilo(item.aboveTokens)}K`}</span>)}
        </div>
        <p className="muted calc-hint">{copy.ctxHint}</p>
      </div>
      <label className="search-toggle">
        <input type="checkbox" checked={web} onChange={() => setWeb(!web)} data-testid="pricing-calc-web" />
        <span>{copy.searchLabel}<small>{fill(copy.searchSmall, { n: formatCredits(WEB_SEARCH_SURCHARGE_CREDITS) })}</small></span>
        <span className="chip">+{numberFormat.format(WEB_SEARCH_SURCHARGE_CREDITS)}</span>
      </label>
    </div>
    <div className="panel glow">
      <div className="calc-per">
        <span className="muted">{copy.perLabel}</span>
        <span><b className="big-num" data-testid="pricing-calc-per">{numberFormat.format(perSend)}</b> <span className="muted">{creditUnit}</span></span>
      </div>
      <p className="calc-break" data-testid="pricing-calc-breakdown">
        {fill(copy.breakdown, { models: numberFormat.format(models), mult: numberFormat.format(multiplier) })}
        {web ? fill(copy.breakdownWeb, { web: numberFormat.format(searchCredits) }) : null}
      </p>
      <div className="result-rows">
        {counts.map((plan) => <div key={plan.id} className="result-row" data-testid={`pricing-calc-result-${plan.id}`}>
          <span>{plan.name}</span>
          <span className="bar" aria-hidden="true"><i style={{ width: `${Math.max(2, Math.min(100, (plan.requests / largest) * 100))}%` }} /></span>
          <b>{fill(copy.requests, { n: numberFormat.format(plan.requests) })}</b>
        </div>)}
      </div>
      <p className="note">{copy.note}</p>
      <p className="note calc-higher">{higherNote}</p>
      {longContextNote ? <p className="note" data-testid="pricing-calc-long-context">{longContextNote}</p> : null}
      {inputLimitNote ? <p className="note" data-testid="pricing-calc-input-limit">{inputLimitNote}</p> : null}
    </div>
  </div>;
}
