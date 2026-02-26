import type { FinClawConfig, ConfigValidationIssue } from '@finclaw/types';
// packages/config/src/validation.ts
import { z } from 'zod/v4';
import { ConfigValidationError } from './errors.js';
import { FinClawConfigSchema } from './zod-schema.js';

export interface ValidationResult {
  valid: boolean;
  config: FinClawConfig;
  issues: ConfigValidationIssue[];
}

/**
 * Zod 기반 2단계 검증
 *
 * 1. safeParse로 스키마 검증
 * 2. 실패 시 z.treeifyError()로 이슈 수집, 빈 {} 반환
 * 3. 성공 시 validated config 반환
 */
export function validateConfig(raw: unknown): ValidationResult {
  const result = FinClawConfigSchema.safeParse(raw);

  if (result.success) {
    return {
      valid: true,
      config: result.data as FinClawConfig,
      issues: [],
    };
  }

  const tree = z.treeifyError(result.error) as unknown as ErrorTree;
  const issues = collectIssues(tree);

  return {
    valid: false,
    config: {} as FinClawConfig,
    issues,
  };
}

/**
 * 검증 실패 시 에러를 throw하는 strict 버전
 */
export function validateConfigStrict(raw: unknown): FinClawConfig {
  const { valid, config, issues } = validateConfig(raw);
  if (!valid) {
    throw new ConfigValidationError(
      `Config validation failed: ${issues.map((i) => i.message).join('; ')}`,
      { issues },
    );
  }
  return config;
}

/** treeifyError 반환 구조 (zod v4 $ZodErrorTree 호환) */
interface ErrorTree {
  errors: string[];
  properties?: Record<string, ErrorTree>;
  items?: Record<string, ErrorTree>;
}

/** z.treeifyError 결과를 ConfigValidationIssue[]로 평탄화 */
function collectIssues(tree: ErrorTree, path = ''): ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = [];

  if (tree.errors && tree.errors.length > 0) {
    for (const msg of tree.errors) {
      issues.push({
        path: path || '(root)',
        message: msg,
        severity: 'error',
      });
    }
  }

  if (tree.properties) {
    for (const [key, subtree] of Object.entries(tree.properties)) {
      const childPath = path ? `${path}.${key}` : key;
      issues.push(...collectIssues(subtree, childPath));
    }
  }

  if (tree.items) {
    for (const [index, subtree] of Object.entries(tree.items)) {
      const childPath = path ? `${path}[${index}]` : `[${index}]`;
      issues.push(...collectIssues(subtree, childPath));
    }
  }

  return issues;
}
