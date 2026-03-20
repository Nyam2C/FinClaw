// packages/tui/src/App.tsx

import type {
  ChatStreamDeltaParams,
  ChatStreamErrorParams,
  ChatStreamToolStartParams,
  ChatStreamToolEndParams,
} from '@finclaw/types';
import { Box, useInput, useApp } from 'ink';
import React, { useState, useEffect, useCallback } from 'react';
import { ChatView, type ChatMessage } from './ChatView.js';
import { DashboardView } from './DashboardView.js';
import { createGatewayClient, type GatewayClient } from './gateway-client.js';
import { StatusBar, type TuiPanel } from './StatusBar.js';

interface AppProps {
  gatewayUrl: string;
  token: string;
  agentId: string;
}

const PANELS: TuiPanel[] = ['chat', 'market', 'portfolio', 'alerts', 'settings'];

export function App({ gatewayUrl, token, agentId }: AppProps) {
  const { exit } = useApp();
  const [panel, setPanel] = useState<TuiPanel>('chat');
  const [connected, setConnected] = useState(false);
  const [sessionId, setSessionId] = useState('');
  const [model, setModel] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamText, setStreamText] = useState('');

  // Gateway 클라이언트 (한 번만 생성)
  const [client] = useState<GatewayClient>(() =>
    createGatewayClient({
      reconnectOptions: {
        initialDelayMs: 800,
        multiplier: 1.7,
        maxDelayMs: 15_000,
      },
    }),
  );

  // 연결 + 세션 시작
  useEffect(() => {
    client.onConnected(async () => {
      setConnected(true);
      try {
        // chat.start → sessionId 획득
        const result = (await client.request('chat.start', { agentId })) as {
          sessionId: string;
        };
        setSessionId(result.sessionId);

        // session.get으로 모델 정보 획득 (not session.info)
        const info = (await client.request('session.get', {
          sessionId: result.sessionId,
        })) as { model: string };
        setModel(info.model);
      } catch {
        // 세션 시작 실패 시 연결은 유지
      }
    });

    client.onDisconnected(() => setConnected(false));

    // notification 라우팅 (method 기반)
    client.onNotification((method, params) => {
      switch (method) {
        case 'chat.stream.delta': {
          // 증분 누적 (전체 교체가 아님!)
          const { delta } = params as unknown as ChatStreamDeltaParams;
          setStreamText((prev) => prev + delta);
          break;
        }
        case 'chat.stream.end':
          setStreamText('');
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: 'assistant',
              content: streamText,
            },
          ]);
          break;
        case 'chat.stream.error': {
          const { error } = params as unknown as ChatStreamErrorParams;
          setStreamText('');
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: 'system',
              content: `[Error] ${error}`,
            },
          ]);
          break;
        }
        case 'chat.stream.tool_start': {
          const { toolCall } = params as unknown as ChatStreamToolStartParams;
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: 'system',
              content: `[Tool] ${toolCall.name}`,
            },
          ]);
          break;
        }
        case 'chat.stream.tool_end': {
          const { result } = params as unknown as ChatStreamToolEndParams;
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: 'tool',
              content: JSON.stringify(result),
            },
          ]);
          break;
        }
      }
    });

    client.connect(gatewayUrl, token).catch(() => {
      // 초기 연결 실패 시 자동 재연결 스케줄링됨
    });

    return () => client.disconnect();
  }, []);

  // 키보드 단축키
  useInput((input, key) => {
    if (key.tab) {
      setPanel((prev) => PANELS[(PANELS.indexOf(prev) + 1) % PANELS.length]);
    }
    if (input === 'q' && key.ctrl) exit();
  });

  // 메시지 전송
  const sendMessage = useCallback(
    async (text: string) => {
      if (!sessionId) return;
      setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'user', content: text }]);
      await client.request('chat.send', {
        sessionId,
        message: text,
        idempotencyKey: crypto.randomUUID(),
      });
    },
    [sessionId, client],
  );

  // 슬래시 명령어 처리
  const handleCommand = useCallback(
    (command: string) => {
      const cmd = command.slice(1).toLowerCase();
      switch (cmd) {
        case 'help':
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: 'system',
              content: 'Commands: /help, /market, /portfolio, /alerts, /settings, /quit',
            },
          ]);
          break;
        case 'market':
        case 'portfolio':
        case 'alerts':
        case 'settings':
          setPanel(cmd);
          break;
        case 'quit':
          exit();
          break;
        default:
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: 'system',
              content: `Unknown command: ${command}`,
            },
          ]);
      }
    },
    [exit],
  );

  return (
    <Box flexDirection="column" height="100%">
      <StatusBar connected={connected} model={model} panel={panel} />
      {panel === 'chat' ? (
        <ChatView
          messages={messages}
          streamText={streamText}
          onSend={sendMessage}
          onCommand={handleCommand}
        />
      ) : (
        <DashboardView panel={panel} client={client} />
      )}
    </Box>
  );
}
