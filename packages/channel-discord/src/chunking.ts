/**
 * 텍스트를 maxLength 이하, maxLines 이하의 청크로 분할한다.
 *
 * 분할 우선순위 (높은 순):
 * 1. 빈 줄 (단락 경계)
 * 2. 줄바꿈
 * 3. 마침표 + 공백 (문장 경계)
 * 4. 공백 (단어 경계)
 * 5. 강제 분할 (maxLength 위치)
 *
 * 코드 블록(```) 내부에서의 분할 시, 닫는/여는 코드 블록 마커를 자동 삽입한다.
 */
export function chunkText(text: string, maxLength: number = 2000, maxLines: number = 17): string[] {
  if (text.length <= maxLength && countLines(text) <= maxLines) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;
  let inCodeBlock = false;
  let codeBlockLang = '';

  while (remaining.length > 0) {
    if (remaining.length <= maxLength && countLines(remaining) <= maxLines) {
      chunks.push(remaining);
      break;
    }

    // maxLength와 maxLines 중 더 작은 위치에서 분할
    let splitIndex = findSplitPoint(remaining, maxLength, maxLines);

    let chunk = remaining.slice(0, splitIndex);

    // 코드 블록 처리: 열린 코드 블록이 닫히지 않았으면 닫아준다
    const codeBlockState = trackCodeBlocks(chunk, inCodeBlock, codeBlockLang);

    if (codeBlockState.unclosed) {
      chunk += '\n```';
      inCodeBlock = true;
      codeBlockLang = codeBlockState.lang;
    } else {
      inCodeBlock = false;
      codeBlockLang = '';
    }

    chunks.push(chunk.trim());

    remaining = remaining.slice(splitIndex).trim();

    // 이전 청크에서 코드 블록이 열려 있었으면, 이어서 코드 블록을 연다
    if (inCodeBlock) {
      remaining = `\`\`\`${codeBlockLang}\n${remaining}`;
    }
  }

  return chunks.filter((c) => c.length > 0);
}

function countLines(text: string): number {
  return text.split('\n').length;
}

/** 분할 지점 탐색 — maxLength와 maxLines 이중 제한 */
function findSplitPoint(text: string, maxLength: number, maxLines: number): number {
  // maxLines 기준 위치 계산
  const lines = text.split('\n');
  let lineLimit = text.length;
  if (lines.length > maxLines) {
    lineLimit = lines.slice(0, maxLines).join('\n').length;
  }

  const effectiveMax = Math.min(maxLength, lineLimit);
  const searchRange = text.slice(0, effectiveMax);

  // 1. 빈 줄 (단락 경계)
  const doubleNewline = searchRange.lastIndexOf('\n\n');
  if (doubleNewline > effectiveMax * 0.5) {
    return doubleNewline + 2;
  }

  // 2. 줄바꿈
  const newline = searchRange.lastIndexOf('\n');
  if (newline > effectiveMax * 0.3) {
    return newline + 1;
  }

  // 3. 마침표 + 공백 (문장 경계)
  const sentence = searchRange.lastIndexOf('. ');
  if (sentence > effectiveMax * 0.3) {
    return sentence + 2;
  }

  // 4. 공백 (단어 경계)
  const space = searchRange.lastIndexOf(' ');
  if (space > effectiveMax * 0.3) {
    return space + 1;
  }

  // 5. 강제 분할
  return effectiveMax;
}

/** 코드 블록 상태 추적 */
function trackCodeBlocks(
  text: string,
  wasInCodeBlock: boolean,
  prevLang: string,
): { unclosed: boolean; lang: string } {
  const codeBlockRegex = /```(\w*)/g;
  let isOpen = wasInCodeBlock;
  let lang = prevLang;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (isOpen) {
      isOpen = false;
      lang = '';
    } else {
      isOpen = true;
      lang = match[1] ?? '';
    }
  }

  return { unclosed: isOpen, lang };
}
