// ── 타입 ──

/** 트랜스크립트 엔트리 */
export interface TranscriptEntry {
  readonly role: 'user' | 'assistant' | 'system' | 'tool';
  readonly content: string;
  readonly timestamp: string;
  readonly toolUseId?: string;
  readonly toolName?: string;
}

/** 트랜스크립트 손상 유형 */
export type CorruptionType =
  | 'truncated-json'
  | 'duplicate-entry'
  | 'orphan-tool-result'
  | 'missing-tool-result'
  | 'invalid-role-sequence';

/** 개별 손상 보고 */
export interface DetectedCorruption {
  readonly type: CorruptionType;
  readonly index: number;
  readonly description: string;
}

/** 손상 보고서 */
export interface CorruptionReport {
  readonly corruptions: readonly DetectedCorruption[];
  readonly isRecoverable: boolean;
}

// ── 손상 감지 ──

/**
 * 트랜스크립트 손상 감지
 *
 * 검사 항목:
 * - duplicate-entry: timestamp + role + content 동일 엔트리 중복
 * - orphan-tool-result: tool_use 없이 tool role 등장
 * - missing-tool-result: assistant의 tool_use 후 tool role 누락
 * - invalid-role-sequence: tool이 assistant 없이 등장
 * - missing-tool-result (empty): 빈 content의 tool 엔트리 (abort 가능성)
 */
export function detectCorruption(entries: readonly TranscriptEntry[]): CorruptionReport {
  const corruptions: DetectedCorruption[] = [];

  // 중복 감지용 set
  const seen = new Set<string>();

  // 이전 assistant의 tool_use 추적
  const pendingToolUseIds = new Set<string>();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];

    // ① 중복 엔트리 감지
    const key = `${entry.timestamp}|${entry.role}|${entry.content}`;
    if (seen.has(key)) {
      corruptions.push({
        type: 'duplicate-entry',
        index: i,
        description: `Duplicate entry at index ${i} (same timestamp, role, content)`,
      });
    }
    seen.add(key);

    // ② orphan tool result 감지
    if (entry.role === 'tool' && entry.toolUseId) {
      if (!pendingToolUseIds.has(entry.toolUseId)) {
        corruptions.push({
          type: 'orphan-tool-result',
          index: i,
          description: `Tool result at index ${i} has no matching tool_use (toolUseId: ${entry.toolUseId})`,
        });
      } else {
        pendingToolUseIds.delete(entry.toolUseId);
      }
    }

    // ③ assistant의 tool_use 추적 (content에서 toolUseId 추출)
    if (entry.role === 'assistant' && entry.toolUseId) {
      pendingToolUseIds.add(entry.toolUseId);
    }

    // ④ invalid role sequence: tool이 이전에 assistant 없이 등장
    if (entry.role === 'tool') {
      const prevNonTool = entries.slice(0, i).findLast((e) => e.role !== 'tool');
      if (prevNonTool && prevNonTool.role !== 'assistant') {
        corruptions.push({
          type: 'invalid-role-sequence',
          index: i,
          description: `Tool result at index ${i} not preceded by assistant message`,
        });
      }
    }

    // ⑤ 빈 tool content (abort 가능성)
    if (entry.role === 'tool' && entry.content === '') {
      corruptions.push({
        type: 'missing-tool-result',
        index: i,
        description: 'Empty tool result (possibly aborted)',
      });
    }
  }

  // ⑥ 매칭되지 않은 tool_use → missing-tool-result
  // pendingToolUseIds에 남아있는 것은 tool_result가 누락된 tool_use
  for (const toolUseId of pendingToolUseIds) {
    // 해당 tool_use의 인덱스 찾기
    const idx = entries.findIndex((e) => e.role === 'assistant' && e.toolUseId === toolUseId);
    if (idx >= 0) {
      corruptions.push({
        type: 'missing-tool-result',
        index: idx,
        description: `Assistant tool_use at index ${idx} has no corresponding tool result (toolUseId: ${toolUseId})`,
      });
    }
  }

  return {
    corruptions,
    isRecoverable: corruptions.every((c) => c.type !== 'truncated-json'),
  };
}

// ── 복구 ──

/**
 * 트랜스크립트 복구
 *
 * 복구 전략:
 * - duplicate-entry: 중복 제거 (첫 번째 유지)
 * - orphan-tool-result: 합성 assistant tool_use 엔트리 삽입
 * - missing-tool-result: 합성 "[Tool result unavailable]" 삽입
 * - invalid-role-sequence: 순서 위반 엔트리 유지 (경고만)
 * - empty tool content: "[Execution aborted]"로 교체
 */
export function repairTranscript(
  entries: readonly TranscriptEntry[],
  report: CorruptionReport,
): TranscriptEntry[] {
  const result = [...entries] as TranscriptEntry[];

  // 타입별로 분류
  const duplicateIndices = new Set<number>();
  const orphanIndices = new Set<number>();
  const missingToolResultIndices = new Set<number>();
  const emptyToolIndices = new Set<number>();

  for (const corruption of report.corruptions) {
    switch (corruption.type) {
      case 'duplicate-entry':
        duplicateIndices.add(corruption.index);
        break;
      case 'orphan-tool-result':
        orphanIndices.add(corruption.index);
        break;
      case 'missing-tool-result':
        if (
          entries[corruption.index]?.role === 'tool' &&
          entries[corruption.index]?.content === ''
        ) {
          emptyToolIndices.add(corruption.index);
        } else {
          missingToolResultIndices.add(corruption.index);
        }
        break;
      // invalid-role-sequence: 유지 (경고만)
      default:
        break;
    }
  }

  // 1. 중복 제거 (뒤에서부터 제거하여 인덱스 유지)
  const sortedDuplicates = [...duplicateIndices].toSorted((a, b) => b - a);
  for (const idx of sortedDuplicates) {
    result.splice(idx, 1);
  }

  // 인덱스별 정확한 오프셋 계산 헬퍼 (대상 인덱스보다 앞에서 제거된 수만 차감)
  const removedAsc = [...duplicateIndices].toSorted((a, b) => a - b);
  function countRemovedBefore(idx: number): number {
    let count = 0;
    for (const r of removedAsc) {
      if (r < idx) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }

  // 2. 빈 tool content → "[Execution aborted]"로 교체
  for (const idx of emptyToolIndices) {
    const adjustedIdx = idx - countRemovedBefore(idx);
    if (adjustedIdx >= 0 && adjustedIdx < result.length) {
      result[adjustedIdx] = {
        ...result[adjustedIdx],
        content: '[Execution aborted]',
      };
    }
  }

  // 3. orphan tool result → 합성 assistant tool_use 삽입
  const orphanList = [...orphanIndices].toSorted((a, b) => a - b);
  let insertOffset = 0;
  for (const idx of orphanList) {
    const adjustedIdx = idx - countRemovedBefore(idx) + insertOffset;
    if (adjustedIdx >= 0 && adjustedIdx < result.length) {
      const orphan = result[adjustedIdx];
      const syntheticAssistant: TranscriptEntry = {
        role: 'assistant',
        content: `[Synthetic tool_use for orphan result]`,
        timestamp: orphan.timestamp,
        toolUseId: orphan.toolUseId,
        toolName: orphan.toolName ?? '[unknown-tool]',
      };
      result.splice(adjustedIdx, 0, syntheticAssistant);
      insertOffset++;
    }
  }

  // 4. missing tool result → 합성 tool result 삽입
  const missingList = [...missingToolResultIndices].toSorted((a, b) => a - b);
  for (const idx of missingList) {
    const adjustedIdx = idx - countRemovedBefore(idx) + insertOffset + 1; // assistant 뒤에 삽입
    if (adjustedIdx >= 0 && adjustedIdx <= result.length) {
      const assistant = entries[idx];
      const syntheticTool: TranscriptEntry = {
        role: 'tool',
        content: '[Tool result unavailable]',
        timestamp: assistant.timestamp,
        toolUseId: assistant.toolUseId,
        toolName: assistant.toolName ?? '[unknown-tool]',
      };
      result.splice(adjustedIdx, 0, syntheticTool);
      insertOffset++;
    }
  }

  return result;
}
