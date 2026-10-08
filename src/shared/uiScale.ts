// Interface size. The renderer is full of fixed pixel sizes (text-[11px]
// and friends), so a root font-size change wouldn't reach most of it;
// instead main scales the whole page with webContents.setZoomFactor.
// The settings sheet offers STEPS, ⌘/Ctrl +/−/0 walk through them.

export const UI_SCALE_STEPS = [0.85, 1, 1.1, 1.25, 1.5] as const;
export const UI_SCALE_DEFAULT = 1;
const UI_SCALE_MIN = 0.75;
const UI_SCALE_MAX = 2;

/// Guard against a hand-edited or corrupt overgit.json: anything that
/// isn't a finite number falls back to 1, the rest is clamped.
export function clampUiScale(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return UI_SCALE_DEFAULT;
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, value));
}

/// Next step up (+1) or down (-1) from `current`. A value between steps
/// (only possible from a hand edit) moves to the nearest step in that
/// direction; one outside the steps' range snaps to the nearest end.
export function stepUiScale(current: number, direction: 1 | -1): number {
  const cur = clampUiScale(current);
  if (direction > 0) {
    return UI_SCALE_STEPS.find((s) => s > cur + 1e-6) ?? UI_SCALE_STEPS[UI_SCALE_STEPS.length - 1];
  }
  return [...UI_SCALE_STEPS].reverse().find((s) => s < cur - 1e-6) ?? UI_SCALE_STEPS[0];
}
