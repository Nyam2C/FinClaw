// packages/server/src/plugins — barrel export
export { PluginSecurityError, RegistryFrozenError } from './errors.js';

export type { HookPayloadMap, HookModeMap } from './hook-types.js';

export { createHookRunner } from './hooks.js';
export type {
  HookMode,
  HookTapOptions,
  VoidHookRunner,
  ModifyingHookRunner,
  SyncHookRunner,
} from './hooks.js';

export {
  createEmptyRegistry,
  getPluginRegistry,
  setPluginRegistry,
  freezeRegistry,
  isRegistryFrozen,
  registerToSlot,
  getSlot,
} from './registry.js';
export type { SlotName } from './registry.js';

export { parseManifest, PluginManifestSchema, manifestJsonSchema } from './manifest.js';

export { discoverPlugins, validatePluginPath, isAllowedExtension } from './discovery.js';
export type { DiscoveredPlugin } from './discovery.js';

export { loadPlugins } from './loader.js';
export type { PluginBuildApi, LoadResult } from './loader.js';
