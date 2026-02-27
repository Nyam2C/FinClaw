// packages/server/src/plugins/errors.ts
// TODO(review): this.name 수동 재할당 패턴 — infra FinClawError에 new.target.name 적용 시 일괄 제거 가능.
import { FinClawError } from '@finclaw/infra';

/** 플러그인 로딩 실패 */
export class PluginLoadError extends FinClawError {
  constructor(pluginName: string, phase: string, cause: Error) {
    super(`Plugin '${pluginName}' failed at ${phase}`, 'PLUGIN_LOAD_ERROR', {
      cause,
      details: { pluginName, phase },
    });
    this.name = 'PluginLoadError';
  }
}

/** 플러그인 보안 검증 실패 */
export class PluginSecurityError extends FinClawError {
  constructor(message: string) {
    super(message, 'PLUGIN_SECURITY_ERROR', { statusCode: 403 });
    this.name = 'PluginSecurityError';
  }
}

/** 레지스트리 동결 후 등록 시도 */
export class RegistryFrozenError extends FinClawError {
  constructor(slot: string) {
    super(`Cannot register to '${slot}' after initialization complete`, 'REGISTRY_FROZEN');
    this.name = 'RegistryFrozenError';
  }
}
