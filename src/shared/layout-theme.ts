/** Internal layout recipes. Only the preset id is a persisted preference.
 * Sizes are CSS pixels / Electron DIPs; OS display scaling is already applied.
 * Persisted `-wide` ids remain stable; the UI calls these variants Relaxed.
 * Relaxed variants add horizontal room and 10% larger typography. */
export const LAYOUT_THEMES = {
  '1080p-standard': { fontScale: 1, widthScale: 1, window: { width: 1440, height: 900 } },
  '1080p-wide': { fontScale: 1.1, widthScale: 1.25, window: { width: 1760, height: 900 } },
  '2k-standard': { fontScale: 1.2, widthScale: 1.2, window: { width: 1920, height: 1200 } },
  '2k-wide': { fontScale: 1.32, widthScale: 1.5, window: { width: 2360, height: 1200 } },
  '4k-standard': { fontScale: 1.5, widthScale: 1.5, window: { width: 2560, height: 1600 } },
  '4k-wide': { fontScale: 1.65, widthScale: 1.875, window: { width: 3360, height: 1600 } },
} as const;

export type LayoutTheme = keyof typeof LAYOUT_THEMES;
export const DEFAULT_LAYOUT_THEME: LayoutTheme = '1080p-standard';
export const LAYOUT_THEME_IDS = Object.keys(LAYOUT_THEMES) as LayoutTheme[];

export function isLayoutTheme(value: unknown): value is LayoutTheme {
  return typeof value === 'string' && Object.hasOwn(LAYOUT_THEMES, value);
}

export function readLayoutTheme(value: unknown): LayoutTheme {
  return isLayoutTheme(value) ? value : DEFAULT_LAYOUT_THEME;
}

/** Main appends the saved preset to each window's renderer argv so the first
 * frame (the launch splash in particular) is already themed; settings
 * hydration stays the authority and corrects a stale value after a reload. */
const LAYOUT_THEME_SWITCH = '--weftcut-layout-theme=';

export const layoutThemeArgument = (id: LayoutTheme) => `${LAYOUT_THEME_SWITCH}${id}`;

export function readLayoutThemeArgument(argv: readonly string[]): LayoutTheme | null {
  const value = argv.find(arg => arg.startsWith(LAYOUT_THEME_SWITCH))?.slice(LAYOUT_THEME_SWITCH.length);
  return isLayoutTheme(value) ? value : null;
}

/** Native window floor before preset scaling (see main/mainWindowConfig.ts). */
export const LAYOUT_MINIMUM_WINDOW = { width: 960, height: 640 } as const;

/** Logical display height → target text scale. Text grows sub-linearly so
 * larger logical displays also gain working room. Anchors match the presets. */
const RECOMMENDATION_ANCHORS: ReadonlyArray<readonly [height: number, scale: number]> = [
  [1080, 1],
  [1440, 1.2],
  [2160, 1.5],
];

/** Interpolates between anchors; past the last one the final segment extends. */
function targetFontScale(height: number): number {
  const anchors = RECOMMENDATION_ANCHORS;
  if (height <= anchors[0][0]) return anchors[0][1];
  let i = 1;
  while (i < anchors.length - 1 && height > anchors[i][0]) i++;
  const [h0, s0] = anchors[i - 1];
  const [h1, s1] = anchors[i];
  return s0 + ((height - h0) * (s1 - s0)) / (h1 - h0);
}

interface Size { width: number; height: number }

/** Advisory only: the user's saved preset is never changed automatically.
 * Inputs are DIPs for the display showing the window, so OS scaling is already
 * applied. Height drives the text scale; width only limits it below 4:3 (for
 * example portrait displays). Presets whose minimum window cannot fit the work
 * area are skipped. */
export function recommendLayoutTheme(display: Size, workArea: Size): LayoutTheme {
  const effectiveHeight = Math.min(display.height, display.width * 0.75);
  const target = targetFontScale(effectiveHeight);
  const fits = (id: LayoutTheme) => {
    const { fontScale, widthScale } = LAYOUT_THEMES[id];
    return Math.round(LAYOUT_MINIMUM_WINDOW.width * widthScale) <= workArea.width
      && Math.round(LAYOUT_MINIMUM_WINDOW.height * fontScale) <= workArea.height;
  };
  const ladder = [...LAYOUT_THEME_IDS].sort((a, b) => LAYOUT_THEMES[a].fontScale - LAYOUT_THEMES[b].fontScale);
  let best: LayoutTheme = DEFAULT_LAYOUT_THEME;
  let bestDistance = Infinity;
  for (const id of ladder) {
    if (!fits(id)) continue;
    const distance = Math.abs(LAYOUT_THEMES[id].fontScale - target);
    // Strictly closer only, so a tie keeps the smaller preset.
    if (distance < bestDistance - 1e-6) {
      best = id;
      bestDistance = distance;
    }
  }
  return best;
}
