// packages/tui/src/StatusBar.tsx

import { Box, Text } from 'ink';
import React from 'react';

export type TuiPanel = 'chat' | 'market' | 'portfolio' | 'alerts' | 'settings';

interface StatusBarProps {
  connected: boolean;
  model: string;
  panel: TuiPanel;
}

export function StatusBar({ connected, model, panel }: StatusBarProps) {
  return (
    <Box borderStyle="single" paddingX={1} justifyContent="space-between">
      <Text>
        <Text color={connected ? 'green' : 'red'}>
          {connected ? '● Connected' : '○ Disconnected'}
        </Text>
        {model && <Text color="gray"> | {model}</Text>}
      </Text>
      <Text>
        <Text color="cyan">[{panel}]</Text>
        <Text color="gray"> Tab: switch | Ctrl+Q: quit</Text>
      </Text>
    </Box>
  );
}
