// packages/config/src/sessions/session-key.ts
import { createSessionKey, type SessionKey } from '@finclaw/types';
import type { SessionScope } from './types.js';

/**
 * 세션 키 정규화
 *
 * scope와 식별자를 결합하여 일관된 SessionKey를 생성한다.
 * - 소문자 변환
 * - 허용 문자: a-z, 0-9, -, _
 * - 비허용 문자는 _ 로 치환
 * - 연속 _ 제거
 * - 빈 identifier → 'default'
 */
export function deriveSessionKey(scope: SessionScope, identifier: string): SessionKey {
  const normalized = identifier
    .toLowerCase()
    .replace(/[^a-z0-9\-_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');

  const id = normalized || 'default';
  return createSessionKey(`${scope}:${id}`);
}
