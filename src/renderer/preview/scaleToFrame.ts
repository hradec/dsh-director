import { centerShift } from './centerInFrame';
import { layerQuad, type LayerQuadInput } from './gizmoGeometry';
import { quadAabb } from './previewSnap';

export type FrameScaleMode = 'fit' | 'fill';

/** Preserve rotation, aspect ratio and mirrors, then center the visible box.
 * Fill projects the composition onto the layer's axes to cover every corner. */
export function scaleToFrame(frame: LayerQuadInput, compW: number, compH: number, mode: FrameScaleMode) {
  const box = quadAabb(layerQuad(frame));
  const crop = frame.visibleRect;
  const w = frame.naturalW * (crop?.w ?? 1) * Math.abs(frame.scaleX);
  const h = frame.naturalH * (crop?.h ?? 1) * Math.abs(frame.scaleY);
  if (!box || ![compW, compH, w, h].every(n => Number.isFinite(n) && n > 0)) return null;
  const radians = frame.rotationDeg * Math.PI / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  const factor = mode === 'fit'
    ? Math.min(compW / (box.right - box.left), compH / (box.bottom - box.top))
    : Math.max((compW * cos + compH * sin) / w, (compW * sin + compH * cos) / h);
  if (!Number.isFinite(factor) || factor <= 0) return null;
  const scaled = { ...frame, scaleX: frame.scaleX * factor, scaleY: frame.scaleY * factor };
  const shift = centerShift(scaled, compW, compH);
  return shift ? { scaleX: scaled.scaleX, scaleY: scaled.scaleY, x: scaled.x + shift.x, y: scaled.y + shift.y } : null;
}
