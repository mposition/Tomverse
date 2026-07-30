// UI-012 (option B): keeps semantic accent colours addressed by role.
//
// The rule is not "no purple anywhere" -- it is that inside the guarded files
// an accent hue must be reached through the role token that owns it, so a
// reader can tell Deep Research's violet from AI Review's violet, and so
// changing one role cannot silently move another. Two roles resolving to the
// same palette step today (accent-promotion and status-success are both
// emerald) still get separate tokens, because they are separate decisions.
//
// It is deliberately scoped. Admin panels, generic status colours and the
// primary blue/zinc palette are outside it: widening the net without a design
// decision behind it is exactly what UI-012 asked not to do. Add a file here
// when its role is tokenised, not before.

import { readFileSync } from "node:fs";

const GUARDED_FILES = [
  "components/auth/AuthButton.tsx",
  "components/chat/ChatInput.tsx",
  "components/chat/ComparisonActionRail.tsx",
  "components/chat/ComparisonReviewDialog.tsx",
  "components/chat/DeepResearchSetupSheet.tsx",
  "components/chat/ModelPickerPanel.tsx",
  "components/chat/ModelSelectionBadge.tsx",
  "components/chat/SidebarAccountRailButton.tsx",
  "components/marketing/AiReviewDemo.tsx",
  "components/marketing/EvidenceSection.tsx",
  "components/marketing/LandingPageContent.tsx",
  "components/marketing/ModelCatalogueSection.tsx",
  "components/marketing/PricingPageContent.tsx",
  "components/marketing/ProductProofSection.tsx",
  "components/marketing/TrustSection.tsx",
];

// The hues that carry a semantic role in this product. `blue` and `zinc` are
// the neutral/primary palette and stay freely usable; `red` and `amber` are
// status colours owned by their own conventions.
const ROLE_HUES = ["cyan", "emerald", "fuchsia", "purple", "sky", "teal", "violet"];

const UTILITIES = [
  "bg",
  "text",
  "border",
  "ring",
  "from",
  "via",
  "to",
  "shadow",
  "fill",
  "stroke",
  "divide",
  "outline",
  "decoration",
  "caret",
  "accent",
];

const RAW_UTILITY = new RegExp(
  `\\b(?:${UTILITIES.join("|")})-(?:${ROLE_HUES.join("|")})-\\d+\\b`,
  "g"
);

// Roles that exist, so a typo like `bg-accent-deepresearch-500` is caught here
// rather than rendering as no colour at all.
const KNOWN_ROLES = [
  "accent-account",
  "accent-ai-review-start",
  "accent-ai-review-mid",
  "accent-ai-review-end",
  "accent-deep-research",
  "accent-model-catalogue",
  "accent-plan-max",
  "accent-promotion",
  "accent-web-search",
  "status-success",
];

const ROLE_UTILITY = new RegExp(
  `\\b(?:${UTILITIES.join("|")})-(accent-[a-z-]+?|status-[a-z-]+?)-\\d+\\b`,
  "g"
);

const themeSource = readFileSync("app/globals.css", "utf8");
const failures = [];

for (const file of GUARDED_FILES) {
  const source = readFileSync(file, "utf8");
  const lines = source.split("\n");

  lines.forEach((line, index) => {
    // A comment explaining why a colour was chosen is not a colour.
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;

    for (const match of line.match(RAW_UTILITY) ?? []) {
      failures.push(
        `${file}:${index + 1}  raw accent utility "${match}" -- use the role token that owns this hue ` +
          `(see AGENTS.md "Accent colour roles")`
      );
    }

    for (const match of line.matchAll(ROLE_UTILITY)) {
      const role = match[1];
      if (!KNOWN_ROLES.includes(role)) {
        failures.push(
          `${file}:${index + 1}  unknown role "${role}" in "${match[0]}" -- known roles: ${KNOWN_ROLES.join(", ")}`
        );
        continue;
      }
      const token = `--color-${match[0].replace(/^[a-z]+-/, "")}`;
      if (!themeSource.includes(`${token}:`)) {
        failures.push(
          `${file}:${index + 1}  "${match[0]}" has no token -- add ${token} to app/globals.css`
        );
      }
    }
  });
}

// The reserved combination: only AI Review may use the full cyan -> blue ->
// purple sequence. Anything else pairing the start and end stops is claiming
// AI Review's identity for another feature.
for (const file of GUARDED_FILES) {
  if (file.includes("AiReview") || file.includes("ComparisonReview")) continue;
  if (file.includes("ModelSelectionBadge") || file.includes("ComparisonActionRail")) continue;
  const source = readFileSync(file, "utf8");
  if (source.includes("accent-ai-review-")) {
    failures.push(
      `${file}  uses an accent-ai-review-* token; the cyan/blue/purple gradient is reserved for AI Review`
    );
  }
}

if (failures.length > 0) {
  console.error("Accent token check failed:\n");
  for (const failure of failures) console.error(`  ${failure}`);
  console.error(
    `\n${failures.length} problem(s). Define the role in app/globals.css and use its token, ` +
      "or state the exception in AGENTS.md before adding a raw accent utility."
  );
  process.exit(1);
}

console.log(
  `Accent token check passed (${GUARDED_FILES.length} guarded files, ${KNOWN_ROLES.length} roles).`
);
