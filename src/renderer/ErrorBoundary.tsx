import React from 'react';

interface State {
  error: Error | null;
}

/// Catches render-time exceptions anywhere in the tree so a single
/// component crashing doesn't blank the entire window. The previous
/// behavior — black screen with no chrome — was the worst-of-all-worlds:
/// no clue what failed, no way to recover without restarting Electron.
/// Here we show the error message + stack, plus a "Reload window" button
/// that the user can hit without leaving the app.
export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('Renderer crash:', error, info.componentStack);
  }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="h-full p-8 overflow-auto bg-surface text-ink">
        <h1 className="text-lg font-semibold mb-2">Something broke in the renderer.</h1>
        <p className="text-xs text-ink-faint mb-4">
          The error is shown below. Click Reload to restart the renderer
          process — your repos and worksets are persisted on disk so
          nothing is lost.
        </p>
        <pre className="text-xs font-mono whitespace-pre-wrap p-3 rounded border border-card bg-card text-red-300">
          {this.state.error.name}: {this.state.error.message}
          {this.state.error.stack ? '\n\n' + this.state.error.stack : ''}
        </pre>
        <div className="mt-4 flex gap-2">
          <button
            onClick={() => window.location.reload()}
            className="text-xs px-3 py-1.5 rounded bg-accent text-white hover:bg-accent-strong"
          >
            Reload window
          </button>
          <button
            onClick={() => this.setState({ error: null })}
            className="text-xs px-3 py-1.5 rounded border border-card hover:bg-card"
          >
            Dismiss & try again
          </button>
        </div>
      </div>
    );
  }
}
