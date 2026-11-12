import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkedCaption } from './BranchPicker';

describe('checkedCaption', () => {
  afterEach(() => vi.useRealTimers());

  it('says "checked just now" rather than "as of now ago"', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-12T10:00:10Z'));
    expect(checkedCaption('2026-11-12T10:00:00Z')).toBe('checked just now');
  });

  it('keeps "as of 5m ago" for older checks', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-12T10:05:00Z'));
    expect(checkedCaption('2026-11-12T10:00:00Z')).toBe('as of 5m ago');
  });
});
