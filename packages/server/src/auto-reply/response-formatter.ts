// packages/server/src/auto-reply/response-formatter.ts

/**
 * 긴 메시지 분할
 *
 * 줄 바꿈 기준으로 분할하며, 코드 블록 내부는 분할하지 않는다.
 */
export function splitMessage(content: string, maxLength: number): readonly string[] {
  if (content.length <= maxLength) {
    return [content];
  }

  const parts: string[] = [];
  let remaining = content;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      parts.push(remaining);
      break;
    }

    // 줄 바꿈 위치에서 분할 시도
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt <= 0) {
      // 줄 바꿈이 없으면 공백에서 분할
      splitAt = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitAt <= 0) {
      // 공백도 없으면 강제 분할
      splitAt = maxLength;
    }

    parts.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return parts;
}
