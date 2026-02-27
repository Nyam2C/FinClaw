// packages/server/src/plugins/registry.ts
import type { PluginRegistry } from '@finclaw/types';
import { RegistryFrozenError } from './errors.js';

const REGISTRY_KEY = Symbol.for('finclaw.plugin-registry');

interface RegistryState {
  registry: PluginRegistry;
  frozen: boolean;
}

export function createEmptyRegistry(): PluginRegistry {
  return {
    plugins: [],
    tools: [],
    channels: [],
    hooks: [],
    services: [],
    commands: [],
    routes: [],
    diagnostics: [],
  };
}

// globalThis 싱글턴 초기화 (IIFE)
const state: RegistryState = (() => {
  const g = globalThis as Record<symbol, unknown>;
  if (!g[REGISTRY_KEY]) {
    g[REGISTRY_KEY] = { registry: createEmptyRegistry(), frozen: false };
  }
  return g[REGISTRY_KEY] as RegistryState;
})();

export type SlotName = keyof PluginRegistry;

/** 현재 레지스트리 반환 */
export function getPluginRegistry(): PluginRegistry {
  return state.registry;
}

/** 레지스트리 교체 (테스트 격리용) + frozen 해제 */
export function setPluginRegistry(registry: PluginRegistry): void {
  state.registry = registry;
  state.frozen = false;
}

/** 레지스트리 동결 — 이후 registerToSlot 호출 시 RegistryFrozenError */
export function freezeRegistry(): void {
  state.frozen = true;
}

/** 레지스트리 동결 여부 */
export function isRegistryFrozen(): boolean {
  return state.frozen;
}

/** 슬롯에 엔트리 등록 */
export function registerToSlot<S extends SlotName>(
  slot: S,
  entry: PluginRegistry[S][number],
): void {
  if (state.frozen) {
    throw new RegistryFrozenError(slot);
  }
  (state.registry[slot] as unknown[]).push(entry);
}

// TODO(review): getSlot() — shallow copy + Object.freeze 호출마다 GC 부담.
// Phase 6+ 프로파일링 후 hot path면 캐싱 또는 Proxy 기반 읽기 전용 뷰로 교체 검토.
/** 슬롯 조회 (frozen 복사본 반환) */
export function getSlot<S extends SlotName>(slot: S): ReadonlyArray<PluginRegistry[S][number]> {
  return Object.freeze([...state.registry[slot]]) as ReadonlyArray<PluginRegistry[S][number]>;
}
