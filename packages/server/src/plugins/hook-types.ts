// packages/server/src/plugins/hook-types.ts
import type { InboundMessage } from '@finclaw/types';

/** 훅 이름 → payload 타입 매핑 */
export interface HookPayloadMap {
  beforeMessageProcess: InboundMessage;
  afterMessageProcess: InboundMessage;
  beforeAgentRun: { agentId: string; sessionKey: string };
  afterAgentRun: { agentId: string; sessionKey: string; result: unknown };
  onConfigChange: { changedPaths: string[] };
  onGatewayStart: void;
  onGatewayStop: void;
  onPluginLoaded: { pluginName: string; slots: string[] };
  onPluginUnloaded: { pluginName: string };
  beforeToolExecute: {
    toolName: string;
    input: Record<string, unknown>;
    context: { sessionId: string; userId: string; channelId: string };
    skip?: boolean;
    skipResult?: { content: string; isError: boolean };
  };
  afterToolExecute: {
    toolName: string;
    input: Record<string, unknown>;
    context: { sessionId: string; userId: string; channelId: string };
    result: {
      content: string;
      isError: boolean;
      wasTruncated: boolean;
      wasRedacted: boolean;
      originalSize: number;
      guardedSize: number;
    };
    durationMs: number;
  };
}

/** 훅 이름 → 실행 모드 매핑 */
export interface HookModeMap {
  beforeMessageProcess: 'modifying';
  afterMessageProcess: 'void';
  beforeAgentRun: 'modifying';
  afterAgentRun: 'void';
  onConfigChange: 'void';
  onGatewayStart: 'void';
  onGatewayStop: 'void';
  onPluginLoaded: 'void';
  onPluginUnloaded: 'void';
  beforeToolExecute: 'modifying';
  afterToolExecute: 'void';
}
