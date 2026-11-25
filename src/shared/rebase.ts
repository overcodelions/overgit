// Pure helpers for interactive rebase, shared by the main process
// (which enforces them) and the renderer (which explains them early).

import type { RebaseStep } from './types';

/// Check a step list against the planned commits: every commit exactly
/// once, nothing squashed into nothing, and rewords carry a message.
export function validateRebaseSteps(
  planned: string[],
  steps: RebaseStep[],
): string | null {
  if (steps.length !== planned.length) return 'The step list does not match the branch’s commits.';
  const want = new Set(planned);
  const seen = new Set<string>();
  for (const s of steps) {
    if (!want.has(s.sha) || seen.has(s.sha)) {
      return 'The step list does not match the branch’s commits.';
    }
    seen.add(s.sha);
  }
  const kept = steps.filter((s) => s.action !== 'drop');
  if (kept.length === 0) return 'Every commit is set to drop. Use reset instead if that is what you want.';
  if (kept[0].action === 'squash' || kept[0].action === 'fixup') {
    return 'The first kept commit can’t be squashed or fixed up: there is no earlier commit to fold it into.';
  }
  for (const s of steps) {
    if (s.action === 'reword' && !s.message?.trim()) return 'A reworded commit needs a message.';
  }
  return null;
}

/// True when the steps would replay the commits exactly as they are.
export function isNoopRebase(planned: string[], steps: RebaseStep[]): boolean {
  return (
    steps.length === planned.length &&
    steps.every((s, i) => s.sha === planned[i] && s.action === 'pick')
  );
}
