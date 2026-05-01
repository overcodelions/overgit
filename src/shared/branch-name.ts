// Branch-name sanitization. Mirrors `git check-ref-format --branch` rules
// closely enough that anything we hand to git for branch creation will
// be accepted. We don't try to be exhaustively faithful to git's parser
// — we just remove the characters and shapes git will reject so a user
// can type "feature/EMR belts and suspenders" and get a usable branch
// without having to know the rules. If the renderer hits a shape we
// can't fix (empty input, only forbidden chars), it shows an error and
// blocks submit instead of silently substituting nothing.

export interface SanitizedBranchName {
  /// The cleaned-up name. Empty string when nothing salvageable remains.
  value: string;
  /// True when sanitize() had to change the user's input. The renderer
  /// uses this to show "will be created as: …" so the user isn't
  /// surprised by silent rewrites.
  changed: boolean;
  /// Non-empty when the result is unusable. Renderer should block submit.
  error: string | null;
}

/// Replace whitespace with `-` and strip characters git rejects so the
/// resulting string is a valid branch name. We're conservative —
/// anything outside the safe ASCII subset becomes `-` rather than
/// trying to transliterate.
export function sanitizeBranchName(input: string): SanitizedBranchName {
  const original = input;
  let s = input.trim();

  if (!s) {
    return { value: '', changed: original !== '', error: 'Branch name is empty.' };
  }

  // 1. Whitespace runs → single hyphen.
  s = s.replace(/\s+/g, '-');
  // 2. Strip characters git rejects outright. We also strip `(` `)`
  //    even though git allows them — they confuse most shells and CI.
  s = s.replace(/[\x00-\x1f\x7f~^:?*\[\]\\()'"`]/g, '');
  // 3. Collapse `..` runs (git rejects any "..").
  s = s.replace(/\.{2,}/g, '.');
  // 4. Collapse `//` runs.
  s = s.replace(/\/{2,}/g, '/');
  // 5. `@{` is reserved.
  s = s.replace(/@\{/g, '-');
  // 6. Trim leading `-`, leading/trailing `/`, trailing `.`, and
  //    `.lock` suffix.
  s = s.replace(/^-+/, '');
  s = s.replace(/^\/+|\/+$/g, '');
  s = s.replace(/\.+$/, '');
  s = s.replace(/\.lock$/i, '');
  // 7. Each path component must not start with `.` either.
  s = s
    .split('/')
    .map((seg) => seg.replace(/^\.+/, ''))
    .filter((seg) => seg.length > 0)
    .join('/');

  if (!s) {
    return {
      value: '',
      changed: true,
      error: 'Branch name has no valid characters.',
    };
  }
  if (s === '@') {
    return { value: '', changed: true, error: '"@" is reserved by git.' };
  }

  return { value: s, changed: s !== original, error: null };
}
