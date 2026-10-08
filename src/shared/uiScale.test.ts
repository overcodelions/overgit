import { describe, it, expect } from 'vitest';
import { clampUiScale, stepUiScale } from './uiScale';

describe('clampUiScale', () => {
  it('keeps values in range', () => {
    expect(clampUiScale(1.25)).toBe(1.25);
  });

  it('clamps to 0.75–2', () => {
    expect(clampUiScale(0.2)).toBe(0.75);
    expect(clampUiScale(5)).toBe(2);
  });

  it('falls back to 1 for missing or junk values', () => {
    expect(clampUiScale(undefined)).toBe(1);
    expect(clampUiScale('big')).toBe(1);
    expect(clampUiScale(Number.NaN)).toBe(1);
  });
});

describe('stepUiScale', () => {
  it('walks up and down the steps', () => {
    expect(stepUiScale(1, 1)).toBe(1.1);
    expect(stepUiScale(1.1, 1)).toBe(1.25);
    expect(stepUiScale(1, -1)).toBe(0.85);
  });

  it('stays put at either end', () => {
    expect(stepUiScale(1.5, 1)).toBe(1.5);
    expect(stepUiScale(0.85, -1)).toBe(0.85);
  });

  it('snaps an off-step value to the next step in that direction', () => {
    expect(stepUiScale(1.2, 1)).toBe(1.25);
    expect(stepUiScale(1.2, -1)).toBe(1.1);
  });

  it('snaps a value outside the steps to the nearest end', () => {
    expect(stepUiScale(2, 1)).toBe(1.5);
    expect(stepUiScale(0.75, -1)).toBe(0.85);
  });
});
