import type { HistoryEntityRef } from "../ipc";
import {
  revealLayerWithoutSeek,
  revealTrackWithoutSelection,
} from "../state/navigation";

/// The post-jump linkage: select what the entry touched and reveal where it
/// lives — without moving the playhead (spec decision 8).
///
/// `projectJumpTo` now resolves after its version is published to the store.
/// Callers await that command before revealing; object identity and timers are
/// not publication signals (a no-op legitimately retains the same snapshot).

/// Resolve one entry's `affected` refs against the LIVE project index and
/// select + reveal the first thing that resolves. Returns true when something
/// was revealed.
///
/// Layers win over Tracks regardless of position: "select the first resolvable
/// affected layer" is the rule, and a Layer ref is the only one there is
/// anything to select for. A Track-only entry (`add_track` /
/// `add_caption_track`, whose ids are minted inside the recipe with no layer
/// to name) falls through to a reveal-without-selection. Marker refs resolve
/// to nothing — the renderer has no marker-selection model.
export function revealAffected(refs: readonly HistoryEntityRef[]): boolean {
  for (const ref of refs) {
    if (ref.kind === "Layer" && revealLayerWithoutSeek(ref.id)) return true;
  }
  for (const ref of refs) {
    if (ref.kind === "Track" && revealTrackWithoutSelection(ref.id)) return true;
  }
  return false;
}
