/** Discord 어카운트 설정 — config.ts의 Zod 스키마에서 infer한 단일 소스 */
export type { DiscordAccount } from './config.js';

/** 버튼 인터랙션 데이터 */
export interface ApprovalButtonData {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly toolInput: string;
  readonly sessionId: string;
  readonly userId: string;
}
