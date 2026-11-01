/**
 * How the Reports tab shows what a stored report says (read-only, no schema
 * change). Pure functions so the formats are tested without rendering.
 */

type MarketIntelValue =
  | { kind: "number"; value: number; unit: string | null }
  | { kind: "date"; value: string }
  | { kind: "money"; amountMinor: number; currency: string }
  | { kind: "token"; value: string };

export type MarketIntelFactView = {
  competitorId: string;
  factType: string;
  value: MarketIntelValue;
  sourceUrl: string;
  checkedAt: string;
};

export type MarketIntelGroup = {
  competitorId: string;
  /** The registry's display name, or the id when the registry has no row. */
  name: string;
  facts: MarketIntelFactView[];
};

/** Minor units per major unit for a currency, 2 when the runtime does not know the code. */
function fractionDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/** A stored value as one line: money as currency plus amount, a token as it is. */
export function formatMarketIntelValue(value: MarketIntelValue): string {
  switch (value.kind) {
    case "money": {
      const digits = fractionDigits(value.currency);
      return `${value.currency} ${(value.amountMinor / 10 ** digits).toFixed(digits)}`;
    }
    case "number":
      return value.unit ? `${value.value} ${value.unit}` : String(value.value);
    case "date":
    case "token":
      return value.value;
  }
}

/** Facts grouped by competitor, in the order each competitor first appears. */
export function groupMarketIntelFacts(
  facts: MarketIntelFactView[],
  names: Record<string, string>
): MarketIntelGroup[] {
  const groups = new Map<string, MarketIntelGroup>();
  for (const fact of facts) {
    let group = groups.get(fact.competitorId);
    if (!group) {
      group = { competitorId: fact.competitorId, name: names[fact.competitorId] ?? fact.competitorId, facts: [] };
      groups.set(fact.competitorId, group);
    }
    group.facts.push(fact);
  }
  return [...groups.values()];
}

/** The source link is opened only when it is https; anything else is shown as text. */
export const isHttpsUrl = (value: string): boolean => value.startsWith("https://");
