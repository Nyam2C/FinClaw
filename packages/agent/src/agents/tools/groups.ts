import type { PolicyVerdict } from './policy.js';

// ── 도구 그룹 식별자 ──

/** 도구 그룹 식별자 */
export type ToolGroupId =
  | 'finance' // 금융 도구 (시세 조회, 차트, 포트폴리오)
  | 'system' // 시스템 도구 (파일, 프로세스)
  | 'web' // 웹 도구 (검색, 페이지 읽기)
  | 'data' // 데이터 도구 (DB 쿼리, 캐시)
  | 'communication' // 커뮤니케이션 (알림, 메시지)
  | 'custom'; // 사용자 정의

// ── 도구 그룹 정의 ──

/** 도구 그룹 정의 */
export interface ToolGroup {
  readonly id: ToolGroupId;
  readonly displayName: string;
  readonly description: string;
  readonly defaultPolicy: PolicyVerdict;
  /** 이 그룹의 도구가 시스템 프롬프트에 포함될 조건 */
  readonly includeInPromptWhen: 'always' | 'on-demand' | 'never';
}

// ── 내장 그룹 ──

export const BUILT_IN_GROUPS = [
  {
    id: 'finance',
    displayName: '금융 도구',
    description: '시세 조회, 포트폴리오 분석, 뉴스 검색, 차트 생성',
    defaultPolicy: 'allow',
    includeInPromptWhen: 'always',
  },
  {
    id: 'system',
    displayName: '시스템 도구',
    description: '파일 시스템, 프로세스 관리, 환경 정보',
    defaultPolicy: 'require-approval',
    includeInPromptWhen: 'on-demand',
  },
  {
    id: 'web',
    displayName: '웹 도구',
    description: '웹 검색, 페이지 읽기, API 호출',
    defaultPolicy: 'allow',
    includeInPromptWhen: 'always',
  },
  {
    id: 'data',
    displayName: '데이터 도구',
    description: '데이터베이스 쿼리, 캐시 관리',
    defaultPolicy: 'require-approval',
    includeInPromptWhen: 'on-demand',
  },
  {
    id: 'communication',
    displayName: '커뮤니케이션 도구',
    description: '알림 발송, 메시지 전달',
    defaultPolicy: 'allow',
    includeInPromptWhen: 'always',
  },
  {
    id: 'custom',
    displayName: '사용자 정의 도구',
    description: '플러그인/스킬이 등록한 커스텀 도구',
    defaultPolicy: 'require-approval',
    includeInPromptWhen: 'on-demand',
  },
] as const satisfies readonly ToolGroup[];
