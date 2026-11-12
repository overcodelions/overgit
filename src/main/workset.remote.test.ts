import { describe, expect, it } from 'vitest';
import { parseRemoteUrl } from './workset';

describe('parseRemoteUrl', () => {
  it('reads GitHub over HTTPS', () => {
    expect(parseRemoteUrl('https://github.com/acme-co/acme-api.git')).toEqual({
      kind: 'github',
      owner: 'acme-co',
      repo: 'acme-api',
    });
  });

  it('reads HTTPS with credentials in the URL', () => {
    expect(parseRemoteUrl('https://x-access-token@github.com/acme-co/acme-api')).toEqual({
      kind: 'github',
      owner: 'acme-co',
      repo: 'acme-api',
    });
  });

  it('still reads GitHub over SSH, both forms', () => {
    const want = { kind: 'github', owner: 'acme-co', repo: 'acme-api' };
    expect(parseRemoteUrl('git@github.com:acme-co/acme-api.git')).toEqual(want);
    expect(parseRemoteUrl('ssh://git@github.com/acme-co/acme-api.git')).toEqual(want);
  });

  it('reads Bitbucket over HTTPS', () => {
    expect(parseRemoteUrl('https://bitbucket.org/acme-co/acme-web.git')).toEqual({
      kind: 'bitbucket',
      workset: 'acme-co',
      repo: 'acme-web',
    });
  });

  it('leaves other hosts unknown', () => {
    expect(parseRemoteUrl('https://git.acme.example/acme-co/acme-api.git')).toEqual({ kind: 'unknown' });
  });
});
