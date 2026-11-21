import { snapFrameRound } from '../frames';
import { logEmit, updateLayerParamTracks, updatePathTransform, type CompositionSummary, type AnimTrack } from '../ipc';
import { autoKeyTrack } from '../keyframe/autoKey';
import { readParamTrack } from '../keyframe/descriptors';
import { layerFrameAt } from '../preview/centerInFrame';
import { getGizmoProbe } from '../preview/gizmoProbeRegistry';
import { scaleToFrame, type FrameScaleMode } from '../preview/scaleToFrame';
import { resolveAnimated } from '../render/animated';
import { previewRenderTargetId, usePreviewRenderTargetId } from '../state/compositionAnchorStore';
import { focusedPlayheadUs } from '../state/playheadProjection';
import { currentOpenComposition, useOpenComposition } from '../state/projectStore';
import { currentSelection, primaryLayerIdOf, usePrimaryLayerId } from '../state/selectionStore';

export const SCALE_MENU_COMMAND_IDS = ['fitLayerToFrame', 'fillLayerFrame', 'restoreLayerSize'] as const;
const SCALABLE_KINDS = new Set(['VideoClip', 'ImageOverlay', 'Motif', 'CompositionRef']);
const NOISE = 1e-9;

function targetIn(comp: CompositionSummary | null, id: string | null, previewId: string | null) {
  if (!comp || comp.id !== previewId || !id) return null;
  const track = comp.tracks.find(t => t.layers.some(l => l.id === id));
  const layer = track?.layers.find(l => l.id === id);
  return track?.enabled && !track.locked && layer?.enabled && !layer.locked && SCALABLE_KINDS.has(layer.params.kind)
    ? { layer, comp } : null;
}

function scaleTarget() {
  return targetIn(currentOpenComposition(), primaryLayerIdOf(currentSelection()), previewRenderTargetId());
}

export function canScaleLayer(): boolean { return scaleTarget() !== null; }
export function useCanScaleLayer(): boolean {
  return targetIn(useOpenComposition(), usePrimaryLayerId(), usePreviewRenderTargetId()) !== null;
}

/** Scale and positioning land in one undo step, including Path mode.
 * Restore writes only scales and does not require a staged preview. */
export async function scalePrimaryLayer(mode: FrameScaleMode | 'original'): Promise<void> {
  const target = scaleTarget();
  if (!target) return;
  const { layer, comp } = target;
  const time = snapFrameRound(focusedPlayheadUs() - layer.t_start_us, comp.fps_num, comp.fps_den);
  const sx = readParamTrack(layer.params, 'scale_x') ?? { mode: 'Static' as const, value: 1 };
  const sy = readParamTrack(layer.params, 'scale_y') ?? { mode: 'Static' as const, value: 1 };
  let values: Record<string, number> = {
    scale_x: resolveAnimated(sx, time, 1) < 0 ? -1 : 1,
    scale_y: resolveAnimated(sy, time, 1) < 0 ? -1 : 1,
  };
  let dx = 0, dy = 0;
  if (mode !== 'original') {
    const size = getGizmoProbe()?.naturalSizeOf(layer.id);
    const frame = size ? layerFrameAt(layer, layer.t_start_us + time, size) : null;
    const result = frame ? scaleToFrame(frame, comp.width, comp.height, mode) : null;
    if (!result || !frame) {
      void logEmit({ level: 'warn', category: { kind: 'Project' }, source: { kind: 'User' },
        message: 'Cannot scale a clip with unknown or degenerate preview dimensions',
        i18n_key: 'log.scale_layer_unavailable', details: { layerId: layer.id, context: mode } });
      return;
    }
    values = { scale_x: result.scaleX, scale_y: result.scaleY, x: result.x, y: result.y };
    dx = result.x - frame.x;
    dy = result.y - frame.y;
  }
  const path = 'position' in layer.params && layer.params.position?.mode === 'Path';
  const entries: [string, AnimTrack<number>][] = [];
  for (const [key, value] of Object.entries(values)) {
    if (path && (key === 'x' || key === 'y')) continue;
    const fallback = key.startsWith('scale_') ? 1 : 0;
    const track = readParamTrack(layer.params, key) ?? { mode: 'Static' as const, value: fallback };
    if (Math.abs(value - resolveAnimated(track, time, fallback)) < NOISE) continue;
    entries.push([key, autoKeyTrack(track, time, value)]);
  }
  if (path && (Math.abs(dx) >= NOISE || Math.abs(dy) >= NOISE)) {
    await updatePathTransform(layer.id, dx, dy, entries);
  } else if (entries.length) {
    await updateLayerParamTracks(layer.id, entries);
  }
}
