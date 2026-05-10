#!/usr/bin/env node
// Phase 30 D6: HF Hub 1회 모델 다운로드 (사용자 수동 실행).
//
// 외부 API 키 없이 HuggingFace Hub 에서 ONNX cross-encoder 모델 1개 다운로드.
// 실패 시 FinClaw 는 mock fallback 으로 동작 (deterministic, 품질 향상은 X).
//
// 사용:
//   pnpm tsx scripts/download-rerank-model.mjs
//
// 환경변수:
//   RERANK_MODEL_ID — 모델 ID 오버라이드 (기본 Xenova/bge-reranker-v2-m3)

import { homedir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from '@huggingface/transformers';

const modelId = process.env.RERANK_MODEL_ID ?? 'Xenova/bge-reranker-v2-m3';
const cacheDir = join(homedir(), '.cache', 'finclaw', 'models', 'rerank');

console.log(`Downloading ${modelId} to ${cacheDir} ...`);
try {
  await pipeline('text-classification', modelId, { cache_dir: cacheDir });
  console.log('OK — re-ranker model ready');
} catch (err) {
  console.error('Download failed:', err.message);
  console.error('FinClaw will fall back to MockReranker (deterministic, no quality gain).');
  process.exit(1);
}
