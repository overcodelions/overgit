import { describe, expect, it } from 'vitest';
import { withRelatedPRs } from './workset';

const A = 'https://github.com/acme/api/pull/1';
const B = 'https://github.com/acme/web/pull/7';

describe('withRelatedPRs', () => {
  it('appends the block after the author text', () => {
    const out = withRelatedPRs('Fixes the thing.\n\n', 'rate limits', [A, B], A);
    expect(out).toBe(
      [
        'Fixes the thing.',
        '',
        '<!-- overgit:related-prs -->',
        '### Related PRs · rate limits',
        '',
        `- ${A} (this PR)`,
        `- ${B}`,
        '<!-- /overgit:related-prs -->',
      ].join('\n'),
    );
  });

  it('uses the block alone for an empty body', () => {
    expect(withRelatedPRs('', 'x', [A, B], B).startsWith('<!-- overgit:related-prs -->')).toBe(true);
  });

  it('replaces an existing block in place and keeps text on both sides', () => {
    const first = withRelatedPRs('Intro', 'ws', [A], A);
    const edited = `${first}\n\nFooter`;
    const C = 'https://github.com/acme/infra/pull/3';
    const out = withRelatedPRs(edited, 'ws', [A, B, C], A);
    expect(out.startsWith('Intro\n\n<!-- overgit:related-prs -->')).toBe(true);
    expect(out.endsWith('<!-- /overgit:related-prs -->\n\nFooter')).toBe(true);
    expect(out).toContain(`- ${C}`);
    expect(out.match(/overgit:related-prs -->/g)).toHaveLength(2);
  });

  it('is a no-op when the block is already current', () => {
    const once = withRelatedPRs('Body', 'ws', [A, B], A);
    expect(withRelatedPRs(once, 'ws', [A, B], A)).toBe(once);
  });
});
