/**
 * Personal colour from a measured cheek colour.
 *
 * The model boxes the face; the device samples both cheeks inside it; this file decides.
 * A season read off the picture by a model changed between runs on the same
 * photo, while the sampled colour repeats to about one CIELAB unit, so the
 * decision is made here from the measurement and is the same every time.
 *
 * What the decision can and cannot claim:
 *   - Three axes are read from the cheek: undertone (warm or cool), lightness and
 *     saturation. The warm/cool rule is the discriminant Lee & Park (2012) fitted
 *     to expert draping of 136 Korean students; the lightness and saturation
 *     origin and the eight types are Kim et al. (2018), 993 Korean women. Both
 *     were measured with a contact colorimeter, so on a photograph the values
 *     below are a starting point: they are to be replaced by percentiles of this
 *     pipeline's own measured distribution once there is one.
 *   - One uncontrolled photo cannot settle warm against cool. A guided app
 *     re-measures the same person within about a* 2.8 and b* 3.0 (95%), more
 *     than the gap between the warm and cool groups. Each axis therefore carries
 *     a confidence, and the report names a second type: the one that differs on
 *     the least certain axis.
 *   - Hair and eye colour are shown but not used. No measured criterion for them
 *     was found, and dyed hair and coloured lenses are common.
 */

export type StudioSeason = "spring" | "summer" | "autumn" | "winter";
export type StudioTone = "bright" | "light" | "mute" | "deep";
export type StudioConfidence = "clear" | "leaning" | "undecided";
type Lab = readonly [L: number, a: number, b: number];

export const STUDIO_COLOR_CRITERIA = {
  /** Warm when `offset + a*·a + b*·b` exceeds `cut` (Lee & Park 2012, cheek). */
  undertone: { offset: -14.773, a: .406, b: .662, cut: .463, spread: 1.17 },
  /** Light when the cheek L* is above the origin (Kim et al. 2018). */
  lightness: { cut: 65.2, spread: 3 },
  /** Vivid when the cheek's saturation is above the origin (Kim et al. 2018). */
  saturation: { cut: .33, spread: .02 },
} as const;
// `spread` is one standard deviation of re-measuring the same face: the guided-app agreement limits
// carried through each formula, and for lightness half of what a change of light direction alone moves.
// A value within a third of it from the cut is not decided, and within one of it only leans.

const linear = (channel: number) => {
  const value = channel / 255;
  return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
};
const curve = (value: number) => value > .008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116;

/** sRGB to CIELAB, D65. The same conversion must produce any distribution these cuts are fitted to. */
export function studioLab(r: number, g: number, b: number): Lab {
  const [R, G, B] = [linear(r), linear(g), linear(b)];
  const x = curve((R * .4124 + G * .3576 + B * .1805) / .95047);
  const y = curve(R * .2126 + G * .7152 + B * .0722);
  const z = curve((R * .0193 + G * .1192 + B * .9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

const median = (values: number[]) => values.sort((first, second) => first - second)[values.length >> 1];

type Box = readonly [x: number, y: number, width: number, height: number];

/**
 * The two cheeks inside a face box that runs from the brows to the chin and from one cheek's edge to the
 * other: beside the nose, below the eyes, above the mouth corners. A small patch the model picked itself
 * landed on hair or shadow in some runs; cheeks placed by fixed shares of the box do not. Across answers
 * the box's sides, its chin and the eye line agree to about a percent while its top does not (brows in one
 * answer, hairline in the next), so the cheeks hang from the eye line when the eyes were located.
 */
export const studioCheekBoxes = ([x, y, width, height]: Box, eyes?: Box | null): [Box, Box] => {
  const chin = y + height, centre = eyes ? eyes[1] + eyes[3] / 2 : NaN;
  const line = centre > y && centre < y + height * .6 ? centre : y + height * .2;
  const top = line + (chin - line) * .25, tall = (chin - line) * .4;
  return [[x + width * .12, top, width * .24, tall], [x + width * .64, top, width * .24, tall]];
};

/**
 * The cheeks' colour from their RGBA pixels: the median of what lies between the 40th and 90th percentile
 * of lightness, so shadow, stubble and hair below and highlights above do not count. Null when there is
 * too little to read.
 */
export function studioSkinColor(pixels: ArrayLike<number>) {
  const rgb: [number, number, number][] = [];
  for (let i = 0; i + 3 < pixels.length; i += 4) if (pixels[i + 3] >= 200) rgb.push([pixels[i], pixels[i + 1], pixels[i + 2]]);
  if (rgb.length < 16) return null;
  const light = rgb.map(([r, g, b], index) => ({ index, L: studioLab(r, g, b)[0] })).sort((first, second) => first.L - second.L);
  const middle = light.slice(Math.floor(light.length * .4), Math.ceil(light.length * .9)).map(item => rgb[item.index]);
  const [r, g, b] = [0, 1, 2].map(channel => median(middle.map(pixel => pixel[channel])));
  return { rgb: [r, g, b] as const, lab: studioLab(r, g, b), hex: "#" + [r, g, b].map(channel => channel.toString(16).padStart(2, "0")).join("") };
}

const grade = (distance: number, spread: number): StudioConfidence =>
  Math.abs(distance) >= spread ? "clear" : Math.abs(distance) >= spread / 3 ? "leaning" : "undecided";

const types = {
  // [warm][light][vivid] in the eight-type table of Kim et al. 2018.
  warm: { light: { vivid: ["spring", "bright"], soft: ["spring", "light"] }, deep: { vivid: ["autumn", "deep"], soft: ["autumn", "mute"] } },
  cool: { light: { vivid: ["winter", "bright"], soft: ["summer", "light"] }, deep: { vivid: ["winter", "deep"], soft: ["summer", "mute"] } },
} as const;

export type StudioColorVerdict = ReturnType<typeof studioColorVerdict>;

/**
 * The measured decision. `unreliable` is set when the photo's colour cannot be trusted (a colour cast,
 * a filter): the undertone and saturation are then never called more than undecided.
 */
export function studioColorVerdict(skin: { rgb: readonly [number, number, number]; lab: Lab }, unreliable = false) {
  const [L, a, b] = skin.lab, criteria = STUDIO_COLOR_CRITERIA;
  const max = Math.max(...skin.rgb), saturation = max ? (max - Math.min(...skin.rgb)) / max : 0;
  const distances = {
    undertone: criteria.undertone.offset + criteria.undertone.a * a + criteria.undertone.b * b - criteria.undertone.cut,
    lightness: L - criteria.lightness.cut,
    saturation: saturation - criteria.saturation.cut,
  };
  const withheld = (axis: StudioConfidence): StudioConfidence => unreliable ? "undecided" : axis;
  const axes = {
    undertone: { side: distances.undertone > 0 ? "warm" : "cool", confidence: withheld(grade(distances.undertone, criteria.undertone.spread)) },
    lightness: { side: distances.lightness > 0 ? "light" : "deep", confidence: grade(distances.lightness, criteria.lightness.spread) },
    saturation: { side: distances.saturation > 0 ? "vivid" : "soft", confidence: withheld(grade(distances.saturation, criteria.saturation.spread)) },
  } as const;
  const type = (undertone: "warm" | "cool", lightness: "light" | "deep", saturationSide: "vivid" | "soft") => {
    const [season, tone] = types[undertone][lightness][saturationSide];
    return { season: season as StudioSeason, tone: tone as StudioTone, undertone };
  };
  // The second type differs on the least certain axis. Ties go to the undertone, the axis a photo measures worst.
  const order = ["undertone", "saturation", "lightness"] as const;
  const rank = { undecided: 0, leaning: 1, clear: 2 };
  const relative = (axis: (typeof order)[number]) => Math.abs(distances[axis]) / criteria[axis].spread;
  const weakest = [...order].sort((first, second) =>
    rank[axes[first].confidence] - rank[axes[second].confidence] || relative(first) - relative(second))[0];
  const flipped = {
    undertone: weakest === "undertone" ? (axes.undertone.side === "warm" ? "cool" : "warm") : axes.undertone.side,
    lightness: weakest === "lightness" ? (axes.lightness.side === "light" ? "deep" : "light") : axes.lightness.side,
    saturation: weakest === "saturation" ? (axes.saturation.side === "vivid" ? "soft" : "vivid") : axes.saturation.side,
  } as const;
  return {
    axes,
    type: type(axes.undertone.side, axes.lightness.side, axes.saturation.side),
    alternative: type(flipped.undertone, flipped.lightness, flipped.saturation),
  };
}

/** Six named colours and four more per season; the names are locale keys (`colorName` + key). */
export const STUDIO_SEASON_PALETTES = {
  spring: {
    named: [["Coral", "#f26f5e"], ["Peach", "#f9b384"], ["GoldenYellow", "#f2c14e"], ["AppleGreen", "#8fbf4f"], ["Turquoise", "#2fb3ad"], ["Ivory", "#fbefd5"]],
    more: ["#e9967a", "#f0a030", "#7fc8c9", "#d2b48c"],
  },
  summer: {
    named: [["Lavender", "#b7a9d6"], ["PowderBlue", "#a9c4e4"], ["RosePink", "#e3a6b8"], ["BlueGrey", "#a3abb8"], ["Mauve", "#b58ca5"], ["SoftNavy", "#4b5f86"]],
    more: ["#c9d7e8", "#8fa3c8", "#d8bfd8", "#7f8fa6"],
  },
  autumn: {
    named: [["Rust", "#b5512f"], ["Mustard", "#d2a12b"], ["Olive", "#7a7a3a"], ["Terracotta", "#c5714f"], ["Camel", "#c19a6b"], ["ForestGreen", "#2f5d46"]],
    more: ["#8b5e3c", "#a0522d", "#556b2f", "#e0b872"],
  },
  winter: {
    named: [["Black", "#16181d"], ["PureWhite", "#fafbfd"], ["RoyalBlue", "#1f3fa8"], ["Emerald", "#0b7a5c"], ["Fuchsia", "#c2187a"], ["TrueRed", "#c8102e"]],
    more: ["#5b2a86", "#0e7490", "#2b2f3a", "#a7c7f2"],
  },
} as const satisfies Record<StudioSeason, { named: readonly (readonly [string, string])[]; more: readonly string[] }>;

/** The family shown for comparison: the one that sits furthest from each season in undertone and clarity. */
export const STUDIO_SEASON_CONTRAST: Record<StudioSeason, StudioSeason> = { spring: "winter", summer: "autumn", autumn: "summer", winter: "autumn" };
