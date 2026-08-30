/**
 * The only screen in the spike.
 *
 * It is a readiness report, not a product surface: no sign-in, no request to
 * the API, no conversation, no composer. `apps/mobile` is a Phase 3 deliverable
 * (docs/policy/tomverse-chat-delivery-plan.md §10) and the shared UI it would
 * be built from -- `chat-ui`, `api-client` -- does not exist yet. Copying
 * ChatInput or ChatPageClient here to fill the gap would create the second
 * chat implementation the shared packages exist to prevent.
 *
 * Copy is English and inline on purpose. Product strings belong in
 * `locales/*.ts`; this screen is a diagnostic that never ships to a user, and
 * routing it through the product locale files would claim otherwise.
 */
import { useState } from "react";
import { Capacitor } from "@capacitor/core";

import { collectReadinessChecks } from "./readinessChecks";

export const ReadinessScreen = () => {
  // Computed once, in a lazy initialiser rather than an effect. `main.tsx`
  // imports the stylesheet before it mounts this tree, so the custom
  // properties are already applied by the first render -- and reading them in
  // an effect would only add a second render to say the same thing.
  const [checks] = useState(() => {
    const computed = getComputedStyle(document.documentElement);
    return collectReadinessChecks({
      readToken: (name) => computed.getPropertyValue(name).trim(),
      origin: window.location.origin,
      isNative: Capacitor.isNativePlatform(),
    });
  });

  const failed = checks.filter((check) => !check.passed).length;

  return (
    <main className="shell">
      <div className="brand-bar" />
      <h1>Tomverse native shell readiness</h1>
      <p className="lede">
        Local Capacitor bundle spike. Verifies that the shared packages run
        outside Next.js. Not a product surface, and not authenticated.
      </p>

      {checks.map((check) => (
        <div className="check" key={check.id}>
          <span className="check-mark" data-state={check.passed ? "pass" : "fail"}>
            {check.passed ? "✓" : "!"}
          </span>
          <span>
            <span className="check-title">{check.title}</span>
            <br />
            <span className="check-detail">
              <code>{check.detail}</code>
            </span>
          </span>
        </div>
      ))}

      <p className="lede" data-testid="readiness-summary" style={{ marginTop: 24 }}>
        {failed === 0
          ? `All ${checks.length} checks passed.`
          : `${failed} of ${checks.length} checks failed.`}
      </p>
    </main>
  );
};
