// packages/tui/src/ChatView.tsx

import { Box, Text, Static } from 'ink';
import TextInput from 'ink-text-input';
import React, { useState } from 'react';

export interface ChatMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'system' | 'tool';
  readonly content: string;
}

interface ChatViewProps {
  messages: ChatMessage[];
  streamText: string;
  onSend: (text: string) => Promise<void>;
  onCommand: (command: string) => void;
}

const ROLE_COLORS: Record<string, string> = {
  user: 'blue',
  assistant: 'green',
  system: 'gray',
  tool: 'magenta',
};

export function ChatView({ messages, streamText, onSend, onCommand }: ChatViewProps) {
  const [input, setInput] = useState('');

  const handleSubmit = async (value: string) => {
    if (!value.trim()) return;
    if (value.startsWith('/')) {
      onCommand(value);
    } else {
      await onSend(value);
    }
    setInput('');
  };

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* 확정된 메시지 (재렌더 없음) */}
      <Static items={messages}>
        {(msg) => (
          <Box key={msg.id}>
            <Text color={ROLE_COLORS[msg.role] ?? 'white'}>
              [{msg.role}] {msg.content}
            </Text>
          </Box>
        )}
      </Static>

      {/* 스트리밍 중인 응답 */}
      {streamText && (
        <Box>
          <Text color="green" dimColor>
            [assistant] {streamText}▊
          </Text>
        </Box>
      )}

      {/* 입력 */}
      <Box>
        <Text color="cyan">&gt; </Text>
        <TextInput value={input} onChange={setInput} onSubmit={handleSubmit} />
      </Box>
    </Box>
  );
}
