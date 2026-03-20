// packages/tui/src/DashboardView.tsx

import { Box, Text } from 'ink';
import React, { useEffect, useState } from 'react';
import type { GatewayClient } from './gateway-client.js';
import type { TuiPanel } from './StatusBar.js';

interface DashboardViewProps {
  panel: TuiPanel;
  client: GatewayClient;
}

interface QuoteData {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
}

interface AlertData {
  id: string;
  name: string;
  conditionType: string;
  active: boolean;
  triggerCount: number;
}

export function DashboardView({ panel, client }: DashboardViewProps) {
  const [data, setData] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client.isConnected) return;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        switch (panel) {
          case 'market': {
            const result = await client.request('finance.quote', {
              symbol: 'AAPL',
            });
            setData(result);
            break;
          }
          case 'portfolio': {
            const result = await client.request('finance.portfolio.get');
            setData(result);
            break;
          }
          case 'alerts': {
            const result = await client.request('finance.alert.list');
            setData(result);
            break;
          }
          case 'settings': {
            const result = await client.request('config.get');
            setData(result);
            break;
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [panel, client.isConnected]);

  if (loading) {
    return (
      <Box>
        <Text color="yellow">Loading {panel}...</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box>
        <Text color="red">Error: {error}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1} padding={1}>
      <Text bold color="cyan">
        [{panel.toUpperCase()}]
      </Text>
      {panel === 'market' && renderMarket(data as QuoteData | null)}
      {panel === 'portfolio' && renderPortfolio(data)}
      {panel === 'alerts' && renderAlerts(data as AlertData[] | null)}
      {panel === 'settings' && renderSettings(data)}
    </Box>
  );
}

function renderMarket(quote: QuoteData | null) {
  if (!quote) return <Text color="gray">No data</Text>;
  const changeColor = quote.change >= 0 ? 'green' : 'red';
  return (
    <Box flexDirection="column">
      <Text>
        {quote.symbol}: ${quote.price.toFixed(2)}{' '}
        <Text color={changeColor}>
          {quote.change >= 0 ? '+' : ''}
          {quote.change.toFixed(2)} ({quote.changePercent.toFixed(2)}%)
        </Text>
      </Text>
    </Box>
  );
}

function renderPortfolio(data: unknown) {
  if (!data) return <Text color="gray">No portfolio data</Text>;
  return (
    <Box flexDirection="column">
      <Text>{JSON.stringify(data, null, 2)}</Text>
    </Box>
  );
}

function renderAlerts(alerts: AlertData[] | null) {
  if (!alerts || alerts.length === 0) {
    return <Text color="gray">No alerts configured</Text>;
  }
  return (
    <Box flexDirection="column">
      {alerts.map((alert) => (
        <Text key={alert.id}>
          {alert.active ? '●' : '○'} {alert.name} [{alert.conditionType}] (triggered:{' '}
          {alert.triggerCount})
        </Text>
      ))}
    </Box>
  );
}

function renderSettings(data: unknown) {
  if (!data) return <Text color="gray">No settings loaded</Text>;
  return (
    <Box flexDirection="column">
      <Text>{JSON.stringify(data, null, 2)}</Text>
    </Box>
  );
}
