import { createLogger } from '@finclaw/infra';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type Client,
} from 'discord.js';
import type { ApprovalButtonData } from './types.js';

const log = createLogger({ name: 'channel-discord' });

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000; // 5분

// pending 승인 Map
const pendingApprovals = new Map<
  string,
  { resolve: (approved: boolean) => void; timer: ReturnType<typeof setTimeout> }
>();

/** 승인/거부 버튼 행 생성 */
export function buildApprovalRow(data: ApprovalButtonData): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`approve:${data.toolCallId}`)
      .setLabel('실행 승인')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`deny:${data.toolCallId}`)
      .setLabel('거부')
      .setStyle(ButtonStyle.Danger),
  );
}

/** 승인 대기 — 타임아웃 */
export function waitForApproval(
  toolCallId: string,
  timeoutMs: number = APPROVAL_TIMEOUT_MS,
): Promise<boolean> {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((r) => {
    resolve = r;
  });

  const timer = setTimeout(() => {
    pendingApprovals.delete(toolCallId);
    resolve(false); // 타임아웃 시 거부
    log.info('Approval timed out', { toolCallId });
  }, timeoutMs);

  pendingApprovals.set(toolCallId, { resolve, timer });
  return promise;
}

/** 버튼 인터랙션 핸들러 등록 */
export function setupApprovalHandler(client: Client): void {
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) {
      return;
    }

    const [action, toolCallId] = interaction.customId.split(':');
    if (!action || !toolCallId) {
      return;
    }
    if (action !== 'approve' && action !== 'deny') {
      return;
    }

    const pending = pendingApprovals.get(toolCallId);
    if (!pending) {
      await interaction.reply({
        content: '이 요청은 이미 만료되었습니다.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    clearTimeout(pending.timer);
    pendingApprovals.delete(toolCallId);

    if (action === 'approve') {
      pending.resolve(true);
      await interaction.update({ content: '도구 실행이 승인되었습니다.', components: [] });
    } else {
      pending.resolve(false);
      await interaction.update({ content: '도구 실행이 거부되었습니다.', components: [] });
    }
  });
}

/** 테스트 유틸: pending 맵 초기화 */
export function _resetPendingApprovals(): void {
  for (const { timer } of pendingApprovals.values()) {
    clearTimeout(timer);
  }
  pendingApprovals.clear();
}
