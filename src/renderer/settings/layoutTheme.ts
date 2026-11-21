import { LAYOUT_THEMES, readLayoutTheme } from '../../shared/layout-theme';
import { useSyncExternalStore } from 'react';
import { UI_METRICS } from './uiMetrics';

let uiScale = 1;
const listeners = new Set<() => void>();
export const getUiScale = () => uiScale;
export function subscribeUiScale(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export const useUiScale = () => useSyncExternalStore(subscribeUiScale, getUiScale);
/** JS-owned layout constraints use the same units as CSS --ui-px. Baselines
 * come from `uiMetrics.ts`. Rounded: boxes, constraints and hit zones. */
export const uiPixels = (baseline: number) => Math.round(baseline * uiScale);
/** Fractional variant for SVG geometry (radii, arm lengths). A component that
 * renders with it must also call `useUiScale()` to re-render on theme changes. */
export const uiScaled = (baseline: number) => baseline * uiScale;

/** Apply on hydration so boot, setting changes and other windows share a path.
 * Root variables also reach dialogs and menus rendered through portals. */
export function applyLayoutTheme(value: unknown): void {
  const id = readLayoutTheme(value);
  const theme = LAYOUT_THEMES[id];
  const changed = uiScale !== theme.fontScale;
  uiScale = theme.fontScale;
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    root.dataset.layoutTheme = id;
    root.style.setProperty('--layout-font-scale', String(theme.fontScale));
    root.style.setProperty('--layout-width-scale', String(theme.widthScale));
    root.style.setProperty('--layout-strip-thickness', `${uiPixels(UI_METRICS.dock.stripThickness)}px`);
  }
  if (changed) for (const listener of listeners) listener();
}

export interface DisplayMetrics {
  width: number;
  height: number;
  availWidth: number;
  availHeight: number;
  /** OS display scaling as a percentage (100 = no scaling). */
  scalePercent: number;
}

let displaySnapshot: DisplayMetrics | null = null;
/** `window.screen` reports DIPs for the display currently showing this window,
 * matching Electron's `screen.getDisplayMatching()` in main. */
function readDisplayMetrics(): DisplayMetrics | null {
  if (typeof window === 'undefined') return null;
  const { width, height, availWidth, availHeight } = window.screen;
  const scalePercent = Math.round(window.devicePixelRatio * 100);
  const prev = displaySnapshot;
  if (prev && prev.width === width && prev.height === height && prev.availWidth === availWidth
    && prev.availHeight === availHeight && prev.scalePercent === scalePercent) return prev;
  displaySnapshot = { width, height, availWidth, availHeight, scalePercent };
  return displaySnapshot;
}

/** Moving to another display changes size or scale, which fires `resize`. */
function subscribeDisplayMetrics(listener: () => void): () => void {
  window.addEventListener('resize', listener);
  return () => window.removeEventListener('resize', listener);
}

export const useDisplayMetrics = () =>
  useSyncExternalStore(subscribeDisplayMetrics, readDisplayMetrics, () => null);
