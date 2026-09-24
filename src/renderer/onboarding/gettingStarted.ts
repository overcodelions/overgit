// The sidebar's getting-started checklist. Every step is derived from what
// the user has, never from a "completed" flag, so it can't get stuck:
// delete your only workspace and the step comes back unticked.

export type GettingStartedKey = 'repos' | 'workspace' | 'workset';

export interface GettingStartedStep {
  key: GettingStartedKey;
  title: string;
  body: string;
  done: boolean;
}

export function gettingStartedSteps(counts: {
  repos: number;
  workspaces: number;
  worksets: number;
}): GettingStartedStep[] {
  return [
    {
      key: 'repos',
      title: 'Add your repos',
      body: 'overgit remembers where they are. Nothing is copied or moved.',
      done: counts.repos > 0,
    },
    {
      key: 'workspace',
      title: 'Group them into a workspace',
      body: 'A lasting group, like “Platform”. Fetch or reset all of it at once.',
      done: counts.workspaces > 0,
    },
    {
      key: 'workset',
      title: 'Start a workset',
      body: 'The ticket you’re shipping. Branch, commit and push its repos together.',
      done: counts.worksets > 0,
    },
  ];
}

/// Shown once there's a repo (before that, the first-run screen does the
/// job) and until every step is done or the user hides it.
export function shouldShowGettingStarted(
  steps: readonly GettingStartedStep[],
  dismissed: boolean | undefined,
): boolean {
  if (dismissed) return false;
  if (!steps[0]?.done) return false;
  return steps.some((s) => !s.done);
}
