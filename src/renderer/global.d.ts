// Renderer can `import './styles.css'` and pull in the typed window.overgit
// API exposed by the preload script. The actual shape lives in
// src/preload/index.ts; this declaration is just the bridge type.

import type { IPCInvokeMap, MainToRendererEvent } from '@shared/types';

declare global {
  interface Window {
    overgit: {
      invoke<K extends keyof IPCInvokeMap>(
        channel: K,
        ...args: Parameters<IPCInvokeMap[K]>
      ): Promise<ReturnType<IPCInvokeMap[K]>>;
      onMainEvent(handler: (event: MainToRendererEvent) => void): () => void;
    };
  }
}

export {};
