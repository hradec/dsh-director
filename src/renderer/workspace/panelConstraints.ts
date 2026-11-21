import type { DockviewApi } from 'dockview-react';
import { getUiScale, subscribeUiScale } from '../settings/layoutTheme';
import { PANEL_REGISTRY, parsePanelId } from './panelRegistry';

/** Below this Dock size (CSS px) Group floors yield toward their baselines, so
 * a scaled theme in a small window scrolls inside panels instead of forcing the
 * grid past the viewport. A viewport threshold, not a themed size. */
const FLOOR_RELAX_BELOW = { width: 1000, height: 720 } as const;

/** Constraints belong to groups in Dockview, not panel APIs. Resolve them
 * again after a theme switch, resize, tab move or restore; never restore stale
 * screen-pixel constraints from a saved layout. The strip owns its own cap. */
export function wirePanelConstraints(api: DockviewApi): () => void {
  const applied = new WeakMap<object, string>();
  let wasScaled = false;
  const refresh = () => {
    const scale = getUiScale();
    if (scale === 1 && !wasScaled) return; // Baseline panels already declare these floors.
    wasScaled = true;
    const widthScale = Math.min(scale, Math.max(1, api.width / FLOOR_RELAX_BELOW.width));
    const heightScale = Math.min(scale, Math.max(1, api.height / FLOOR_RELAX_BELOW.height));
    for (const group of api.groups) {
      const kinds = group.panels.flatMap(panel => {
        const parsed = parsePanelId(panel.id);
        return parsed ? [parsed.kind] : [];
      });
      if (!kinds.length || kinds.length === 1 && kinds[0] === 'quick-actions') continue;
      const minimumWidth = Math.round(Math.max(...kinds.map(kind => PANEL_REGISTRY[kind].minimumWidth)) * widthScale);
      const minimumHeight = Math.round(Math.max(...kinds.map(kind => PANEL_REGISTRY[kind].minimumHeight)) * heightScale);
      const key = `${minimumWidth}:${minimumHeight}`;
      if (applied.get(group) === key) continue;
      // Cache before writing: setConstraints synchronously triggers layout.
      applied.set(group, key);
      group.api.setConstraints({ minimumWidth, minimumHeight });
    }
  };
  const layout = api.onDidLayoutChange(refresh);
  const unsubscribe = subscribeUiScale(refresh);
  refresh();
  return () => { layout.dispose(); unsubscribe(); };
}
