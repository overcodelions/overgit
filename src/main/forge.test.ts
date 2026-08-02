import { describe, it, expect } from 'vitest';
import {
  mapBitbucketRepo,
  mapGitHubRepo,
  mapGitLabProject,
  parseGitCredential,
  sortByUpdated,
} from './forge';
import type { ForgeRepo } from '../shared/types';

describe('parseGitCredential', () => {
  it('reads username and password from fill output', () => {
    const cred = parseGitCredential(
      'protocol=https\nhost=bitbucket.org\nusername=lionel\npassword=s3cret\n\n',
    );
    expect(cred).toEqual({ username: 'lionel', password: 's3cret' });
  });

  it('keeps "=" inside a token value', () => {
    const cred = parseGitCredential('username=me\npassword=abc=def==\n');
    expect(cred?.password).toBe('abc=def==');
  });

  it('falls back to the token username when git reports none', () => {
    expect(parseGitCredential('password=tok\n')?.username).toBe('x-token-auth');
  });

  it('returns null when nothing is stored', () => {
    expect(parseGitCredential('protocol=https\nhost=bitbucket.org\n\n')).toBeNull();
  });
});

describe('mapGitHubRepo', () => {
  it('maps a gh /user/repos entry', () => {
    const repo = mapGitHubRepo({
      full_name: 'acme/widgets',
      name: 'widgets',
      owner: { login: 'acme' },
      description: 'Widget factory',
      private: true,
      default_branch: 'main',
      updated_at: '2026-01-01T00:00:00Z',
      pushed_at: '2026-02-02T00:00:00Z',
      clone_url: 'https://github.com/acme/widgets.git',
      ssh_url: 'git@github.com:acme/widgets.git',
    });
    expect(repo).toEqual({
      provider: 'github',
      fullName: 'acme/widgets',
      name: 'widgets',
      owner: 'acme',
      description: 'Widget factory',
      isPrivate: true,
      defaultBranch: 'main',
      // pushed_at wins — it tracks actual code movement.
      updatedAt: '2026-02-02T00:00:00Z',
      httpsUrl: 'https://github.com/acme/widgets.git',
      sshUrl: 'git@github.com:acme/widgets.git',
    });
  });

  it('derives owner/name and urls from the fields gh always sends', () => {
    const repo = mapGitHubRepo({
      full_name: 'acme/widgets',
      html_url: 'https://github.com/acme/widgets',
    });
    expect(repo?.owner).toBe('acme');
    expect(repo?.name).toBe('widgets');
    expect(repo?.httpsUrl).toBe('https://github.com/acme/widgets.git');
    expect(repo?.sshUrl).toBe('git@github.com:acme/widgets.git');
    expect(repo?.isPrivate).toBe(false);
  });

  it('skips an entry with no usable identity', () => {
    expect(mapGitHubRepo({ description: 'orphan' })).toBeNull();
  });
});

describe('mapGitLabProject', () => {
  it('maps a GitLab project entry', () => {
    const repo = mapGitLabProject({
      path: 'runner',
      path_with_namespace: 'gitlab-org/ci/runner',
      name: 'Runner',
      description: ' CI runner ',
      visibility: 'public',
      default_branch: 'main',
      last_activity_at: '2026-04-04T09:00:00.000Z',
      http_url_to_repo: 'https://gitlab.com/gitlab-org/ci/runner.git',
      ssh_url_to_repo: 'git@gitlab.com:gitlab-org/ci/runner.git',
      namespace: { full_path: 'gitlab-org/ci' },
    });
    expect(repo).toEqual({
      provider: 'gitlab',
      fullName: 'gitlab-org/ci/runner',
      name: 'runner',
      // Subgroups are part of the owner path, not the repo name.
      owner: 'gitlab-org/ci',
      description: 'CI runner',
      isPrivate: false,
      defaultBranch: 'main',
      updatedAt: '2026-04-04T09:00:00.000Z',
      httpsUrl: 'https://gitlab.com/gitlab-org/ci/runner.git',
      sshUrl: 'git@gitlab.com:gitlab-org/ci/runner.git',
    });
  });

  it('treats internal visibility as private', () => {
    const repo = mapGitLabProject({
      path_with_namespace: 'acme/tools',
      visibility: 'internal',
      http_url_to_repo: 'https://gitlab.com/acme/tools.git',
    });
    expect(repo?.isPrivate).toBe(true);
    expect(repo?.owner).toBe('acme');
    expect(repo?.name).toBe('tools');
  });

  it('skips an entry with no clone urls', () => {
    expect(mapGitLabProject({ path_with_namespace: 'acme/tools' })).toBeNull();
  });
});

describe('mapBitbucketRepo', () => {
  it('maps a workspace repo entry', () => {
    const repo = mapBitbucketRepo({
      full_name: 'ws/api',
      slug: 'api',
      name: 'API',
      description: '  Core API  ',
      is_private: true,
      updated_on: '2026-03-03T10:00:00.123456+00:00',
      mainbranch: { name: 'master' },
      links: {
        clone: [
          { name: 'https', href: 'https://me@bitbucket.org/ws/api.git' },
          { name: 'ssh', href: 'git@bitbucket.org:ws/api.git' },
        ],
      },
    });
    expect(repo).toEqual({
      provider: 'bitbucket',
      fullName: 'ws/api',
      name: 'api',
      owner: 'ws',
      description: 'Core API',
      isPrivate: true,
      defaultBranch: 'master',
      updatedAt: '2026-03-03T10:00:00.123456+00:00',
      httpsUrl: 'https://me@bitbucket.org/ws/api.git',
      sshUrl: 'git@bitbucket.org:ws/api.git',
    });
  });

  it('falls back to the ssh remote when only ssh is offered', () => {
    const repo = mapBitbucketRepo({
      full_name: 'ws/api',
      links: { clone: [{ name: 'ssh', href: 'git@bitbucket.org:ws/api.git' }] },
    });
    expect(repo?.httpsUrl).toBe('git@bitbucket.org:ws/api.git');
    expect(repo?.name).toBe('api');
  });

  it('skips an entry with no clone links', () => {
    expect(mapBitbucketRepo({ full_name: 'ws/api', links: { clone: [] } })).toBeNull();
  });
});

describe('sortByUpdated', () => {
  it('puts the most recently touched first and undated last', () => {
    const mk = (fullName: string, updatedAt?: string): ForgeRepo => ({
      provider: 'github',
      fullName,
      name: fullName.split('/')[1],
      owner: fullName.split('/')[0],
      isPrivate: false,
      updatedAt,
      httpsUrl: `https://github.com/${fullName}.git`,
      sshUrl: `git@github.com:${fullName}.git`,
    });
    const sorted = sortByUpdated([
      mk('a/old', '2025-01-01T00:00:00Z'),
      mk('a/undated'),
      mk('a/new', '2026-01-01T00:00:00Z'),
    ]);
    expect(sorted.map((r) => r.name)).toEqual(['new', 'old', 'undated']);
  });
});
