// packages/server/src/channels — barrel export
export { createChannelDock, CORE_DOCKS } from './dock.js';
export type { CreateDockOptions } from './dock.js';

export {
  registerChannelDock,
  getChannelDock,
  hasChannelDock,
  getAllChannelDocks,
  resetChannelRegistry,
} from './registry.js';

export { normalizeChatType, isDirect, isMultiUser } from './chat-type.js';

export { startTyping } from './typing.js';
export type { TypingHandle } from './typing.js';

export { composeGates } from './gating/pipeline.js';
export type { Gate } from './gating/pipeline.js';
export { createMentionGate } from './gating/mention-gating.js';
export { createCommandGate } from './gating/command-gating.js';
export { createAllowlistGate } from './gating/allowlist.js';
