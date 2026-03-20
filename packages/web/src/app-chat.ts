// packages/web/src/app-chat.ts
// Chat queueing/streaming — handles chat.stream.* notifications

import type { AppGateway } from './app-gateway.js';

/** Matches @finclaw/types ChatStreamDeltaParams */
interface ChatDeltaParams {
  readonly sessionId: string;
  readonly delta: string;
}

/** Matches @finclaw/types ChatStreamEndParams */
interface ChatEndParams {
  readonly sessionId: string;
  readonly result: unknown;
}

/** Matches @finclaw/types ChatStreamErrorParams */
interface ChatErrorParams {
  readonly sessionId: string;
  readonly error: string;
}

/** Matches @finclaw/types ChatStreamToolStartParams */
interface ChatToolStartParams {
  readonly sessionId: string;
  readonly toolCall: { readonly name: string; readonly input: unknown };
}

/** Matches @finclaw/types ChatStreamToolEndParams */
interface ChatToolEndParams {
  readonly sessionId: string;
  readonly result: unknown;
}

export type ChatStatus = 'idle' | 'streaming' | 'error';

export interface ChatMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly timestamp: number;
}

export interface ToolActivity {
  readonly name: string;
  readonly input: unknown;
  readonly result?: unknown;
  readonly timestamp: number;
}

export interface ChatState {
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly ToolActivity[];
  readonly status: ChatStatus;
  readonly error: string | null;
  readonly streamBuffer: string;
}

export type ChatStateListener = (state: ChatState) => void;

export interface AppChat {
  sendMessage(text: string): Promise<void>;
  getState(): ChatState;
  onStateChange(listener: ChatStateListener): void;
  offStateChange(listener: ChatStateListener): void;
  flush(): void;
  dispose(): void;
}

export function createAppChat(gateway: AppGateway, sessionId: string): AppChat {
  let state: ChatState = {
    messages: [],
    tools: [],
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
    if (p['sessionId'] !== sessionId) {
      return;
    }

    switch (method) {
      case 'chat.stream.delta': {
        const delta = (p as unknown as ChatDeltaParams).delta;
        setState({ streamBuffer: state.streamBuffer + delta });
        break;
      }
      case 'chat.stream.end': {
        const _endParams = p as unknown as ChatEndParams;
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
        const errorParams = p as unknown as ChatErrorParams;
        setState({
          status: 'error',
          error: errorParams.error,
          streamBuffer: '',
        });
        processQueue();
        break;
      }
      case 'chat.stream.tool_start': {
        const toolParams = p as unknown as ChatToolStartParams;
        const tool: ToolActivity = {
          name: toolParams.toolCall.name,
          input: toolParams.toolCall.input,
          timestamp: Date.now(),
        };
        setState({ tools: [...state.tools, tool] });
        break;
      }
      case 'chat.stream.tool_end': {
        const toolEnd = p as unknown as ChatToolEndParams;
        const tools = [...state.tools];
        const last = tools[tools.length - 1];
        if (last) {
          tools[tools.length - 1] = { ...last, result: toolEnd.result };
          setState({ tools });
        }
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
      await gateway.send('chat.send', { sessionId, message: text });
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
