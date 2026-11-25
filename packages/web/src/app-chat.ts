// packages/web/src/app-chat.ts
// Chat queueing/streaming — handles chat.stream.* notifications

import type {
  ChatStreamDeltaParams,
  ChatStreamEndParams,
  ChatStreamErrorParams,
} from '@finclaw/types';
import type { AppGateway } from './app-gateway.js';

export type ChatStatus = 'idle' | 'streaming' | 'error';

export interface ChatMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly timestamp: number;
}

export interface ChatState {
  readonly messages: readonly ChatMessage[];
  readonly status: ChatStatus;
  readonly error: string | null;
  readonly streamBuffer: string;
}

export type ChatStateListener = (state: ChatState) => void;

export interface AppChat {
  sendMessage(text: string): Promise<void>;
  setSessionId(id: string): void; // ← Phase 37 D(F5): chat.start 후 서버 발급 id 주입
  getState(): ChatState;
  onStateChange(listener: ChatStateListener): void;
  offStateChange(listener: ChatStateListener): void;
  flush(): void;
  dispose(): void;
}

export function createAppChat(gateway: AppGateway, sessionId: string): AppChat {
  // Phase 37 D(F5): chat.start 후 setSessionId 로 교체 가능하도록 let.
  let currentSessionId = sessionId;
  let state: ChatState = {
    messages: [],
    status: 'idle',
    error: null,
    streamBuffer: '',
  };

  const listeners = new Set<ChatStateListener>();
  const queue: string[] = [];
  let processing = false;

  function setState(patch: Partial<ChatState>): void {
    state = { ...state, ...patch };
    for (const listener of listeners) {
      listener(state);
    }
  }

  function handleNotification(method: string, params: Record<string, unknown>): void {
    const p = params as Record<string, unknown>;
    if (p['sessionId'] !== currentSessionId) {
      return;
    }

    switch (method) {
      case 'chat.stream.delta': {
        const delta = (p as unknown as ChatStreamDeltaParams).delta;
        setState({ streamBuffer: state.streamBuffer + delta });
        break;
      }
      case 'chat.stream.end': {
        const _endParams = p as unknown as ChatStreamEndParams;
        const assistantMsg: ChatMessage = {
          role: 'assistant',
          content: state.streamBuffer,
          timestamp: Date.now(),
        };
        setState({
          messages: [...state.messages, assistantMsg],
          streamBuffer: '',
          status: 'idle',
        });
        processQueue();
        break;
      }
      case 'chat.stream.error': {
        const errorParams = p as unknown as ChatStreamErrorParams;
        setState({
          status: 'error',
          error: errorParams.error,
          streamBuffer: '',
        });
        processQueue();
        break;
      }
    }
  }

  async function processQueue(): Promise<void> {
    if (processing || queue.length === 0) {
      return;
    }
    processing = true;

    const text = queue.shift();
    if (!text) {
      processing = false;
      return;
    }

    try {
      setState({ status: 'streaming', error: null, streamBuffer: '' });
      await gateway.send('chat.send', { sessionId: currentSessionId, message: text });
    } catch (err) {
      setState({
        status: 'error',
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
    processing = false;
  }

  gateway.onNotification(handleNotification);

  return {
    async sendMessage(text: string): Promise<void> {
      const userMsg: ChatMessage = {
        role: 'user',
        content: text,
        timestamp: Date.now(),
      };
      setState({ messages: [...state.messages, userMsg] });
      queue.push(text);
      await processQueue();
    },

    setSessionId(id: string): void {
      currentSessionId = id;
    },

    getState(): ChatState {
      return state;
    },

    onStateChange(listener: ChatStateListener): void {
      listeners.add(listener);
    },

    offStateChange(listener: ChatStateListener): void {
      listeners.delete(listener);
    },

    flush(): void {
      queue.length = 0;
      setState({
        streamBuffer: '',
        status: 'idle',
        error: null,
      });
    },

    dispose(): void {
      gateway.offNotification(handleNotification);
      listeners.clear();
      queue.length = 0;
    },
  };
}
