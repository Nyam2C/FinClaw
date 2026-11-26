// packages/server/src/composition/discord-owner.ts
/**
 * Discord 발신자가 소유자인가. 소유자 id 가 설정돼 있지 않으면 아무도 통과하지 못한다 —
 * 에이전트가 소유자의 알림·계좌 조회 도구를 쓰므로, 봇에 닿을 수 있는 다른 사람의 말은 받지 않는다.
 */
export function isDiscordOwner(senderId: string, ownerUserId: string | undefined): boolean {
  return ownerUserId !== undefined && senderId === ownerUserId;
}
