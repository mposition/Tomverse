import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Shared measurement helpers for the Insight UI audit follow-up (UI-001,
 * UI-002, UI-003, UI-007).
 *
 * Every helper here exists because the obvious way to measure the same thing
 * silently passes:
 *
 * - Focusing an input does not raise a keyboard in a headless browser, so a
 *   "footer clears the keyboard" assertion is true before the fix and after it.
 * - `getComputedStyle(el).color` serialises Tailwind v4 colours as CIE `lab()`,
 *   so an `rgb()` regex either throws away the sample or reads it as black.
 */

// ---------------------------------------------------------------------------
// UI-001: on-screen keyboard
// ---------------------------------------------------------------------------

/**
 * Shrinks `window.visualViewport` the way an on-screen keyboard does, leaving
 * the layout viewport (`window.innerHeight`, `100dvh`, `position: fixed`
 * containing block) at its full height -- which is precisely the iOS Safari /
 * Android Chrome "resizes-visual" behaviour that the bug depends on.
 *
 * This is an emulation, not a device. It is faithful about the one property
 * under test (the gap between the layout and visual viewports) and says
 * nothing about keyboard animation timing or browser-specific scroll-into-view
 * behaviour. Those were confirmed once on real iOS Safari and Android Chrome
 * (see .github/audits/ui-insight-followup.md); what runs on every PR is this,
 * and it is what stops the geometry from regressing. A change that reworks the
 * keyboard layout deserves another look on a device -- the emulation will not
 * notice an animation or scroll-anchoring regression.
 */
export async function openOnScreenKeyboard(page: Page, keyboardHeight = 300) {
  await page.evaluate((height) => {
    const viewport = window.visualViewport;
    if (!viewport) throw new Error("visualViewport is unavailable in this browser");
    const own = Object.getOwnPropertyDescriptor(viewport, "height");
    if (!own) {
      const inherited = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(viewport),
        "height"
      );
      Object.defineProperty(viewport, "height", {
        configurable: true,
        get() {
          const real = inherited!.get!.call(viewport) as number;
          const simulated = (window as unknown as Record<string, number>)
            .__simulatedKeyboardHeight;
          return real - (simulated ?? 0);
        },
      });
    }
    (window as unknown as Record<string, number>).__simulatedKeyboardHeight = height;
    viewport.dispatchEvent(new Event("resize"));
  }, keyboardHeight);
  // The subscribers are React `useSyncExternalStore` snapshots; one frame is
  // enough for the re-render and the style flush.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
}

export async function closeOnScreenKeyboard(page: Page) {
  await page.evaluate(() => {
    (window as unknown as Record<string, number>).__simulatedKeyboardHeight = 0;
    window.visualViewport?.dispatchEvent(new Event("resize"));
  });
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
}

export type VisualViewportMetrics = {
  layoutHeight: number;
  visualHeight: number;
  offsetTop: number;
  safeAreaBottom: number;
};

export async function readVisualViewport(page: Page): Promise<VisualViewportMetrics> {
  return page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.position = "fixed";
    probe.style.visibility = "hidden";
    probe.style.height = "env(safe-area-inset-bottom)";
    document.body.appendChild(probe);
    const safeAreaBottom = probe.getBoundingClientRect().height;
    probe.remove();
    return {
      layoutHeight: window.innerHeight,
      visualHeight: window.visualViewport?.height ?? window.innerHeight,
      offsetTop: window.visualViewport?.offsetTop ?? 0,
      safeAreaBottom,
    };
  });
}

/** Asserts the element's whole box, and its centre point, are visible. */
export async function expectInsideVisibleViewport(
  page: Page,
  locator: Locator,
  label: string
) {
  const box = await locator.boundingBox();
  expect(box, `${label}: expected a box`).not.toBeNull();
  const metrics = await readVisualViewport(page);
  const visibleBottom = metrics.offsetTop + metrics.visualHeight;
  expect(box!.y, `${label}: top above the visible viewport`).toBeGreaterThanOrEqual(
    metrics.offsetTop - 1
  );
  expect(
    box!.y + box!.height,
    `${label}: bottom below the visible viewport (${Math.round(
      box!.y + box!.height
    )} > ${Math.round(visibleBottom)})`
  ).toBeLessThanOrEqual(visibleBottom + 1);
  const centreY = box!.y + box!.height / 2;
  expect(centreY, `${label}: centre point not visible`).toBeLessThanOrEqual(visibleBottom);
}

/**
 * The completion criterion for a scrollable candidate: after the browser has
 * brought it into view the way a tap would, its centre point is inside the
 * visible viewport *and* hitting that point reaches the candidate rather than
 * whatever is floating above it.
 */
export async function expectTappableInVisibleViewport(
  page: Page,
  locator: Locator,
  label: string
) {
  // `scrollIntoViewIfNeeded` treats a row that is merely *partly* visible as
  // already in view, which is exactly the case where a sticky footer is
  // covering its centre. Centring it is what a user scrolling towards a row
  // ends up doing, and it is the only position that clears both sticky edges.
  await locator.evaluate((element) =>
    element.scrollIntoView({ block: "center", inline: "nearest" })
  );
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
  const box = await locator.boundingBox();
  expect(box, `${label}: expected a box`).not.toBeNull();
  const metrics = await readVisualViewport(page);
  const centreX = box!.x + box!.width / 2;
  const centreY = box!.y + box!.height / 2;
  expect(centreY, `${label}: centre above the visible viewport`).toBeGreaterThanOrEqual(
    metrics.offsetTop
  );
  expect(centreY, `${label}: centre below the visible viewport`).toBeLessThanOrEqual(
    metrics.offsetTop + metrics.visualHeight
  );
  const hitsSelf = await locator.evaluate(
    (element, [x, y]) => {
      const hit = document.elementFromPoint(x as number, y as number);
      return Boolean(hit) && (hit === element || element.contains(hit));
    },
    [centreX, centreY]
  );
  expect(hitsSelf, `${label}: centre point is covered by something else`).toBe(true);
}

// ---------------------------------------------------------------------------
// UI-002: hit area and overlap
// ---------------------------------------------------------------------------

/**
 * Intersection area, in CSS px², between two elements' border boxes. 0 means
 * they do not overlap at all.
 */
export async function intersectionArea(a: Locator, b: Locator): Promise<number> {
  const [boxA, boxB] = await Promise.all([a.boundingBox(), b.boundingBox()]);
  if (!boxA || !boxB) return 0;
  const width = Math.max(
    0,
    Math.min(boxA.x + boxA.width, boxB.x + boxB.width) - Math.max(boxA.x, boxB.x)
  );
  const height = Math.max(
    0,
    Math.min(boxA.y + boxA.height, boxB.y + boxB.height) - Math.max(boxA.y, boxB.y)
  );
  return width * height;
}

/**
 * The centre and all four corners (inset by 1px so a rounded corner is not
 * sampled outside the shape) must hit the control itself or one of its
 * descendants -- never a different control, and never nothing at all.
 */
export async function expectFivePointHitTest(locator: Locator, label: string) {
  const box = await locator.boundingBox();
  expect(box, `${label}: expected a box`).not.toBeNull();
  // A pill's geometric corners are outside its own shape, so sampling them at
  // a fixed 3px inset tests the page behind the control, not the control. The
  // inset follows the corner radius: `r - r/sqrt(2)` is where the arc actually
  // passes, plus a pixel of slack.
  const radius = await locator.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0
  );
  const effectiveRadius = Math.min(
    radius,
    Math.min(box!.width, box!.height) / 2
  );
  const inset = Math.max(3, Math.ceil(effectiveRadius * (1 - 1 / Math.SQRT2)) + 1);
  const points: Array<[string, number, number]> = [
    ["centre", box!.x + box!.width / 2, box!.y + box!.height / 2],
    ["top-left", box!.x + inset, box!.y + inset],
    ["top-right", box!.x + box!.width - inset, box!.y + inset],
    ["bottom-left", box!.x + inset, box!.y + box!.height - inset],
    ["bottom-right", box!.x + box!.width - inset, box!.y + box!.height - inset],
  ];
  for (const [name, x, y] of points) {
    const hitsSelf = await locator.evaluate(
      (element, [px, py]) => {
        const hit = document.elementFromPoint(px as number, py as number);
        return Boolean(hit) && (hit === element || element.contains(hit));
      },
      [x, y]
    );
    expect(hitsSelf, `${label}: ${name} does not hit the control`).toBe(true);
  }
}

// ---------------------------------------------------------------------------
// UI-003 / UI-007: contrast and type scale
// ---------------------------------------------------------------------------

export type ContrastSample = {
  text: string;
  fontSizePx: number;
  fontWeight: number;
  isLargeText: boolean;
  /** Composited sRGB values actually painted, as 0-255 triples. */
  foreground: [number, number, number];
  background: [number, number, number];
  ratio: number;
  /** 4.5 for body text, 3.0 for WCAG "large" text. */
  required: number;
  passes: boolean;
};

/**
 * Reads a colour through a canvas rather than parsing the serialised string.
 *
 * Tailwind v4 emits `oklch()`, and Chromium serialises the computed value as
 * CIE `lab()`. Any measurement that regexes `rgb(...)` out of
 * `getComputedStyle().color` therefore either drops the sample or silently
 * reads it as black -- which is why the previous baseline could not be
 * reproduced. `fillStyle` + `getImageData()` returns the 8-bit sRGB the user's
 * display actually receives, for every colour syntax the browser accepts.
 */
type RawContrastSample = Omit<ContrastSample, "required" | "passes"> & { selector: string };

/**
 * The measurement itself, as a single page-side pass.
 *
 * Everything happens in one `evaluate` on purpose: the earlier shape tagged
 * each element with a marker attribute and then measured them one Playwright
 * round-trip at a time, which a React re-render could invalidate mid-run --
 * a flake that looked like a missing element rather than a stale mark.
 */
async function measureContrastSamples(
  locator: Locator,
  selfOnly: boolean
): Promise<RawContrastSample[]> {
  return locator.evaluate((root, only) => {
    type Rgba = [number, number, number, number];
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const toRgba = (value: string): Rgba => {
      ctx.fillStyle = "#000000";
      try {
        ctx.fillStyle = value;
      } catch {
        /* an unparseable colour keeps the opaque-black fallback */
      }
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    };
    const over = (fg: Rgba, bg: Rgba): Rgba => {
      const a = fg[3];
      return [
        fg[0] * a + bg[0] * (1 - a),
        fg[1] * a + bg[1] * (1 - a),
        fg[2] * a + bg[2] * (1 - a),
        1,
      ];
    };
    const luminance = ([r, g, b]: [number, number, number]) => {
      const channel = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };

    const describe = (element: Element) => {
      const testId = element.getAttribute("data-testid");
      if (testId) return `[data-testid="${testId}"]`;
      const className = (element.getAttribute("class") ?? "")
        .split(/\s+/)
        .slice(0, 3)
        .join(".");
      return `${element.tagName.toLowerCase()}${className ? `.${className}` : ""}`;
    };

    const measure = (element: Element) => {
      // Outermost first, so the stack composites in paint order. The page's
      // own canvas is the base: a fully transparent chain over it is still
      // painted on top of whatever the root element declares.
      const chain: Element[] = [];
      for (let node: Element | null = element; node; node = node.parentElement) {
        chain.unshift(node);
      }

      let background: Rgba = toRgba(
        getComputedStyle(document.documentElement).backgroundColor
      );
      if (background[3] === 0) background = [255, 255, 255, 1];
      background = [background[0], background[1], background[2], 1];

      // A group opacity applies to everything the subtree paints, including
      // the text, so it is carried forward rather than folded into one layer.
      let inheritedOpacity = 1;
      for (const node of chain) {
        const nodeStyle = getComputedStyle(node);
        const nodeOpacity = Number.parseFloat(nodeStyle.opacity || "1");
        inheritedOpacity *= Number.isFinite(nodeOpacity) ? nodeOpacity : 1;
        const own = toRgba(nodeStyle.backgroundColor);
        if (own[3] > 0) {
          background = over(
            [own[0], own[1], own[2], own[3] * inheritedOpacity],
            background
          );
        }
      }

      const style = getComputedStyle(element);
      const colour = toRgba(style.color);
      const foreground = over(
        [colour[0], colour[1], colour[2], colour[3] * inheritedOpacity],
        background
      );

      const fontSizePx = Number.parseFloat(style.fontSize);
      const rawWeight = style.fontWeight;
      const fontWeight =
        rawWeight === "bold"
          ? 700
          : rawWeight === "normal"
            ? 400
            : Number.parseInt(rawWeight, 10);
      const isLargeText = fontSizePx >= 24 || (fontSizePx >= 18.66 && fontWeight >= 700);

      const fgLuminance = luminance([foreground[0], foreground[1], foreground[2]]);
      const bgLuminance = luminance([background[0], background[1], background[2]]);
      const lighter = Math.max(fgLuminance, bgLuminance);
      const darker = Math.min(fgLuminance, bgLuminance);

      return {
        selector: describe(element),
        text: (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
        fontSizePx,
        fontWeight,
        isLargeText,
        foreground: [
          Math.round(foreground[0]),
          Math.round(foreground[1]),
          Math.round(foreground[2]),
        ] as [number, number, number],
        background: [
          Math.round(background[0]),
          Math.round(background[1]),
          Math.round(background[2]),
        ] as [number, number, number],
        ratio: Math.round(((lighter + 0.05) / (darker + 0.05)) * 100) / 100,
      };
    };

    if (only) return [measure(root)];

    // One sample per text-bearing element: a paragraph is measured on the node
    // that owns the text node, not once more for every wrapper above it.
    const results: ReturnType<typeof measure>[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const seen = new Set<Element>();
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (!(node.textContent ?? "").trim()) continue;
      const element = node.parentElement;
      if (!element || seen.has(element)) continue;
      seen.add(element);
      if (element.closest(".sr-only")) continue;
      // Fallback content of a replaced element. A <video>/<audio>/<canvas>/
      // <object> paints its own media over its children, so this text is
      // only ever shown by a browser that cannot render the element at all.
      // It still owns a non-zero rect (the element's), so without this the
      // walker measures the fallback string against the media's own
      // background and reports a failure for text no user ever sees.
      if (element.closest("video, audio, canvas, object")) continue;
      // WCAG 2.2 SC 1.4.3 exempts "text or images of text that are part of
      // an inactive user interface component". A disabled control is
      // deliberately de-emphasised to signal that it cannot be used; holding
      // it to 4.5:1 would erase the only cue that says so.
      const inactive = element.closest("button, input, select, textarea, fieldset, [aria-disabled='true']");
      if (
        inactive &&
        ((inactive as HTMLButtonElement).disabled === true ||
          inactive.getAttribute("aria-disabled") === "true")
      ) {
        continue;
      }
      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none") continue;
      const rect = element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      results.push(measure(element));
    }
    return results;
  }, selfOnly);
}

const withVerdict = (sample: RawContrastSample, fallbackLabel: string): ContrastSample => {
  const required = sample.isLargeText ? 3 : 4.5;
  return {
    ...sample,
    required,
    passes: sample.ratio >= required,
    text: sample.text || fallbackLabel,
  };
};

export async function measureContrast(
  locator: Locator,
  label: string
): Promise<ContrastSample> {
  const [sample] = await measureContrastSamples(locator, true);
  return withVerdict(sample, label);
}

/** Every text-bearing element inside `root`, measured in one pass. */
export async function measureContrastInScope(
  root: Locator
): Promise<Array<ContrastSample & { selector: string }>> {
  const samples = await measureContrastSamples(root, false);
  return samples.map((sample) => ({
    ...withVerdict(sample, sample.selector),
    selector: sample.selector,
  }));
}

export function formatContrastSample(label: string, sample: ContrastSample) {
  const rgb = (value: [number, number, number]) => `rgb(${value.join(",")})`;
  return `${label}: ${sample.ratio}:1 (needs ${sample.required}) fg=${rgb(
    sample.foreground
  )} bg=${rgb(sample.background)} ${sample.fontSizePx}px/${sample.fontWeight} "${sample.text}"`;
}

export async function expectAccessibleContrast(locator: Locator, label: string) {
  const sample = await measureContrast(locator, label);
  expect(sample.passes, formatContrastSample(label, sample)).toBe(true);
  return sample;
}

/**
 * Every visible, non-empty text node under `root` whose computed font size is
 * below `minimumPx`. `data-allow-small-text` marks the deliberate exceptions
 * (glyph-sized counters inside an avatar, where the value is also in the
 * accessible name).
 */
export async function findUndersizedText(
  root: Locator,
  minimumPx: number
): Promise<Array<{ selector: string; fontSizePx: number; text: string }>> {
  return root.evaluate((container, minimum) => {
    const describe = (element: Element) => {
      const testId = element.getAttribute("data-testid");
      if (testId) return `[data-testid="${testId}"]`;
      const className = (element.getAttribute("class") ?? "").split(/\s+/).slice(0, 3).join(".");
      return `${element.tagName.toLowerCase()}${className ? `.${className}` : ""}`;
    };
    const results: Array<{ selector: string; fontSizePx: number; text: string }> = [];
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const seen = new Set<Element>();
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = (node.textContent ?? "").trim();
      if (!text) continue;
      const element = node.parentElement;
      if (!element || seen.has(element)) continue;
      seen.add(element);
      if (element.closest("[data-allow-small-text]")) continue;
      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none") continue;
      if (element.closest(".sr-only")) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const fontSizePx = Number.parseFloat(style.fontSize);
      if (fontSizePx < minimum) {
        results.push({ selector: describe(element), fontSizePx, text: text.slice(0, 60) });
      }
    }
    return results;
  }, minimumPx);
}
