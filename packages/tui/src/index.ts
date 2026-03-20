// packages/tui/src/index.ts

import { render } from 'ink';
import React from 'react';
import { App } from './App.js';

/**
 * TUI 진입점 — Ink v6 render
 */
export async function runTui(options: {
  gatewayUrl: string;
  token: string;
  agentId?: string;
}): Promise<void> {
  const { gatewayUrl, token, agentId = 'default' } = options;

  const { waitUntilExit } = render(React.createElement(App, { gatewayUrl, token, agentId }));

  await waitUntilExit();
}
