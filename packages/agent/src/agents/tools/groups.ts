import type { PolicyVerdict } from './policy.js';

// ── 도구 그룹 식별자 ──

/** 도구 그룹 식별자 */
export type ToolGroupId =
  | 'finance' // 금융 도구 (시세 조회, 차트, 포트폴리오)
  | 'system' // 시스템 도구 (파일, 프로세스)
  | 'web' // 웹 도구 (검색, 페이지 읽기)
  | 'data' // 데이터 도구 (DB 쿼리, 캐시)
  | 'communication' // 커뮤니케이션 (알림, 메시지)
  | 'mcp' // Phase 29 D: MCP (Model Context Protocol) 외부 도구
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
