import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileUnderRoot, writeFileUnderRoot } from './fs';

let tmp: string;
let root: string;
let outside: string;

beforeEach(() => {
  // Realpath the OS tmp dir up front — on macOS /tmp is a symlink to
  // /private/tmp, and our containment check compares realpaths. Without
  // this the harness's own paths would already look "outside" their own
  // root once normalized.
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'overgit-fs-')));
  root = path.join(tmp, 'repo');
  outside = path.join(tmp, 'elsewhere');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('readFileUnderRoot', () => {
  it('reads a file inside the repo root', () => {
    const p = path.join(root, 'README.md');
    fs.writeFileSync(p, 'hello\n');
    const r = readFileUnderRoot(root, p);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toBe('hello\n');
  });

  it('refuses an absolute path outside the root', () => {
    const evil = path.join(outside, 'secret.txt');
    fs.writeFileSync(evil, 'pwned');
    const r = readFileUnderRoot(root, evil);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/outside the repo/i);
  });

  it('refuses a "../" traversal escape', () => {
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'pwned');
    const traversal = path.join(root, '..', 'elsewhere', 'secret.txt');
    const r = readFileUnderRoot(root, traversal);
    expect(r.ok).toBe(false);
  });

  it('refuses a symlink that points outside the root', () => {
    const target = path.join(outside, 'secret.txt');
    fs.writeFileSync(target, 'pwned');
    const link = path.join(root, 'sneaky-link');
    fs.symlinkSync(target, link);
    const r = readFileUnderRoot(root, link);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/outside the repo/i);
  });

  it('allows a symlink that resolves back inside the root', () => {
    const target = path.join(root, 'real.txt');
    fs.writeFileSync(target, 'inside');
    const link = path.join(root, 'link.txt');
    fs.symlinkSync(target, link);
    const r = readFileUnderRoot(root, link);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toBe('inside');
  });

  it('resolves a relative path against the repo root, not the process cwd', () => {
    const p = path.join(root, 'rel.txt');
    fs.writeFileSync(p, 'rel');
    const r = readFileUnderRoot(root, 'rel.txt');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toBe('rel');
  });

  it('rejects a relative path that escapes via ".."', () => {
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'pwned');
    const r = readFileUnderRoot(root, '../elsewhere/secret.txt');
    expect(r.ok).toBe(false);
  });

  it('rejects a binary file (contains NUL)', () => {
    const p = path.join(root, 'image.bin');
    fs.writeFileSync(p, Buffer.from([0x00, 0x01, 0x02]));
    const r = readFileUnderRoot(root, p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/binary/i);
  });

  it('rejects a file over the 5 MB read cap', () => {
    const p = path.join(root, 'big.txt');
    fs.writeFileSync(p, Buffer.alloc(6 * 1024 * 1024, 'a'));
    const r = readFileUnderRoot(root, p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/MB/);
  });
});

describe('writeFileUnderRoot', () => {
  it('writes a file inside the repo root', () => {
    const p = path.join(root, 'note.txt');
    const r = writeFileUnderRoot(root, p, 'wrote');
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(p, 'utf-8')).toBe('wrote');
  });

  it('writes a new file in a path that does not exist yet', () => {
    // Containment must allow write-new-file: the deepest-existing-ancestor
    // realpath logic exists for exactly this case.
    const p = path.join(root, 'subdir-not-yet');
    fs.mkdirSync(p);
    const target = path.join(p, 'fresh.txt');
    const r = writeFileUnderRoot(root, target, 'fresh');
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(target, 'utf-8')).toBe('fresh');
  });

  it('refuses to write outside the root via absolute path', () => {
    const evil = path.join(outside, 'pwned.txt');
    const r = writeFileUnderRoot(root, evil, 'no');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/outside the repo/i);
    expect(fs.existsSync(evil)).toBe(false);
  });

  it('refuses to write through a symlink pointing outside the root', () => {
    const target = path.join(outside, 'target.txt');
    fs.writeFileSync(target, 'before');
    const link = path.join(root, 'link.txt');
    fs.symlinkSync(target, link);
    const r = writeFileUnderRoot(root, link, 'after');
    expect(r.ok).toBe(false);
    expect(fs.readFileSync(target, 'utf-8')).toBe('before');
  });

  it('refuses to write via "../" traversal', () => {
    const r = writeFileUnderRoot(root, '../elsewhere/pwned.txt', 'no');
    expect(r.ok).toBe(false);
    expect(fs.existsSync(path.join(outside, 'pwned.txt'))).toBe(false);
  });

  it('returns an error result when root does not exist (not a throw)', () => {
    const ghost = path.join(tmp, 'no-such-root');
    const r = writeFileUnderRoot(ghost, path.join(ghost, 'x.txt'), 'x');
    expect(r.ok).toBe(false);
  });
});
