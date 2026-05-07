import { describe, it, expect } from 'vitest';
import { sanitizeBranchName } from './branch-name';

describe('sanitizeBranchName', () => {
  it('passes a clean name through unchanged', () => {
    const r = sanitizeBranchName('feature/login-redesign');
    expect(r).toEqual({ value: 'feature/login-redesign', changed: false, error: null });
  });

  it('errors on empty input', () => {
    const r = sanitizeBranchName('');
    expect(r.value).toBe('');
    expect(r.error).toMatch(/empty/i);
  });

  it('errors on whitespace-only input (trimmed to empty)', () => {
    const r = sanitizeBranchName('   ');
    expect(r.value).toBe('');
    expect(r.error).toMatch(/empty/i);
    expect(r.changed).toBe(true);
  });

  it('collapses whitespace runs into a single hyphen', () => {
    const r = sanitizeBranchName('feature/EMR  belts and suspenders');
    expect(r.value).toBe('feature/EMR-belts-and-suspenders');
    expect(r.changed).toBe(true);
    expect(r.error).toBeNull();
  });

  it('strips git-forbidden characters', () => {
    const r = sanitizeBranchName('foo~bar^baz:qux?wat*woo[hi]\\there');
    expect(r.value).toBe('foobarbazquxwatwoohithere');
    expect(r.error).toBeNull();
  });

  it('strips control characters', () => {
    const r = sanitizeBranchName('feature/\x01\x1ffoo');
    expect(r.value).toBe('feature/foo');
    expect(r.changed).toBe(true);
  });

  it('also strips parens and quotes (shell hostile, even if git allows)', () => {
    const r = sanitizeBranchName(`feature/(scope)-"thing"-'else'-\`tick\``);
    expect(r.value).toBe('feature/scope-thing-else-tick');
  });

  it('collapses ".." runs to a single dot', () => {
    const r = sanitizeBranchName('foo..bar...baz');
    expect(r.value).toBe('foo.bar.baz');
  });

  it('collapses "//" runs to a single slash', () => {
    const r = sanitizeBranchName('foo//bar///baz');
    expect(r.value).toBe('foo/bar/baz');
  });

  it('replaces reserved "@{" sequence', () => {
    const r = sanitizeBranchName('foo@{1}');
    // `[`, `]` and `{` `}` get stripped or replaced via the @{ rule and char strip
    expect(r.value).not.toMatch(/@\{/);
    expect(r.value.length).toBeGreaterThan(0);
  });

  it('strips leading hyphens', () => {
    const r = sanitizeBranchName('---foo');
    expect(r.value).toBe('foo');
  });

  it('strips leading and trailing slashes', () => {
    const r = sanitizeBranchName('/foo/bar/');
    expect(r.value).toBe('foo/bar');
  });

  it('strips trailing dots', () => {
    const r = sanitizeBranchName('foo.bar...');
    expect(r.value).toBe('foo.bar');
  });

  it('strips a trailing .lock suffix (case-insensitive)', () => {
    expect(sanitizeBranchName('feature/foo.lock').value).toBe('feature/foo');
    expect(sanitizeBranchName('feature/foo.LOCK').value).toBe('feature/foo');
  });

  it('strips leading dots from each path segment', () => {
    const r = sanitizeBranchName('foo/.hidden/bar');
    expect(r.value).toBe('foo/hidden/bar');
  });

  it('drops segments that become empty after sanitization', () => {
    const r = sanitizeBranchName('foo/...//bar');
    expect(r.value).toBe('foo/bar');
  });

  it('errors when nothing salvageable remains', () => {
    const r = sanitizeBranchName('~~~^^^');
    expect(r.value).toBe('');
    expect(r.error).toMatch(/no valid characters/i);
  });

  it('errors on the lone "@" reserved name', () => {
    const r = sanitizeBranchName('@');
    expect(r.value).toBe('');
    expect(r.error).toMatch(/reserved/i);
  });

  it('reports changed=false only when output equals original input', () => {
    expect(sanitizeBranchName('clean-name').changed).toBe(false);
    expect(sanitizeBranchName('clean-name ').changed).toBe(true);
    expect(sanitizeBranchName(' clean-name').changed).toBe(true);
  });
});
