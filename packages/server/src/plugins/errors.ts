// packages/server/src/plugins/errors.ts
// TODO(review): this.name 수동 재할당 패턴 — infra FinClawError에 new.target.name 적용 시 일괄 제거 가능.
import { FinClawError } from '@finclaw/infra';

/** 플러그인 보안 검증 실패 */
export class PluginSecurityError extends FinClawError {
  constructor(message: string) {
    super(message, 'PLUGIN_SECURITY_ERROR', { statusCode: 403 });
    this.name = 'PluginSecurityError';
  }
}
