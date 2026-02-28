import type { ToolDefinition } from '@finclaw/types/agent.js';
import type { ChatType } from '@finclaw/types/message.js';

// ── 타입 ──

/** 시스템 프롬프트 섹션 */
export interface PromptSection {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly priority: number; // 높을수록 먼저 배치
  readonly required: boolean;
  readonly tokenEstimate: number;
}

/** 금융 투자 성향 */
export interface InvestmentProfile {
  readonly riskTolerance: 'conservative' | 'moderate' | 'aggressive';
  readonly preferredMarkets: readonly string[];
  readonly complianceLevel: 'retail' | 'professional' | 'institutional';
}

/** 모델 능력 정보 (Phase 6의 ModelCapabilities 참조) */
export interface PromptModelCapabilities {
  readonly supportsTools: boolean;
  readonly supportsVision: boolean;
  readonly supportsStreaming: boolean;
}

/** 시스템 프롬프트 빌더 컨텍스트 */
export interface PromptBuildContext {
  readonly userId: string;
  readonly channelId: string;
  readonly chatType: ChatType;
  readonly availableTools: readonly ToolDefinition[];
  readonly modelCapabilities: PromptModelCapabilities;
  readonly customInstructions?: string;
  /** 금융 특화: 사용자의 투자 성향 */
  readonly investmentProfile?: InvestmentProfile;
}

/** 프롬프트 빌드 모드 */
export type PromptBuildMode = 'full' | 'minimal' | 'none';

// ── 섹션 빌더 ──

export function buildIdentitySection(): PromptSection {
  return {
    id: 'identity',
    title: 'Identity',
    content: [
      'You are FinClaw, an AI financial assistant.',
      'You provide accurate financial information, analysis, and guidance.',
      'You are professional, knowledgeable, and helpful.',
    ].join('\n'),
    priority: 100,
    required: true,
    tokenEstimate: 30,
  };
}

function buildCapabilitiesSection(ctx: PromptBuildContext): PromptSection {
  const capabilities: string[] = ['Financial data analysis', 'Market information retrieval'];
  if (ctx.modelCapabilities.supportsTools) {
    capabilities.push('Tool execution');
  }
  if (ctx.modelCapabilities.supportsVision) {
    capabilities.push('Image analysis');
  }

  return {
    id: 'capabilities',
    title: 'Capabilities',
    content: `Your capabilities:\n${capabilities.map((c) => `- ${c}`).join('\n')}`,
    priority: 95,
    required: true,
    tokenEstimate: 20 + capabilities.length * 5,
  };
}

export function buildToolsSection(tools: readonly ToolDefinition[]): PromptSection {
  if (tools.length === 0) {
    return {
      id: 'tools',
      title: 'Tools',
      content: 'No tools are currently available.',
      priority: 90,
      required: false,
      tokenEstimate: 10,
    };
  }

  const toolDescriptions = tools.map((t) => `- **${t.name}**: ${t.description}`).join('\n');

  return {
    id: 'tools',
    title: 'Available Tools',
    content: `You have access to the following tools:\n${toolDescriptions}`,
    priority: 90,
    required: true,
    tokenEstimate: tools.length * 20,
  };
}

export function buildFinanceContextSection(): PromptSection {
  return {
    id: 'finance-context',
    title: 'Financial Context',
    content: [
      'You operate in the financial domain.',
      'Always provide accurate, up-to-date financial information.',
      'When discussing investments, include relevant risk factors.',
      'Use standard financial terminology and formats.',
    ].join('\n'),
    priority: 85,
    required: true,
    tokenEstimate: 40,
  };
}

export function buildComplianceSection(level: string): PromptSection {
  const rules: string[] = [
    'Never provide personalized investment advice without proper disclaimers.',
    'Always disclose that you are an AI, not a licensed financial advisor.',
    'Do not guarantee investment returns or outcomes.',
  ];

  if (level === 'institutional') {
    rules.push('Follow institutional compliance standards and audit requirements.');
    rules.push('Flag potential regulatory issues proactively.');
  }

  return {
    id: 'compliance',
    title: 'Compliance Guidelines',
    content: `Financial compliance rules:\n${rules.map((r) => `- ${r}`).join('\n')}`,
    priority: 80,
    required: true,
    tokenEstimate: 30 + rules.length * 10,
  };
}

export function buildRiskDisclaimerSection(): PromptSection {
  return {
    id: 'risk-disclaimer',
    title: 'Risk Disclaimer',
    content: [
      'IMPORTANT: Include the following disclaimer when providing investment-related information:',
      '"This information is for educational purposes only and should not be considered financial advice.',
      'Past performance does not guarantee future results. Investing involves risk, including possible loss of principal."',
    ].join('\n'),
    priority: 75,
    required: true,
    tokenEstimate: 50,
  };
}

function buildUserContextSection(ctx: PromptBuildContext): PromptSection {
  const lines: string[] = [`User ID: ${ctx.userId}`];
  if (ctx.investmentProfile) {
    lines.push(`Risk tolerance: ${ctx.investmentProfile.riskTolerance}`);
    if (ctx.investmentProfile.preferredMarkets.length > 0) {
      lines.push(`Preferred markets: ${ctx.investmentProfile.preferredMarkets.join(', ')}`);
    }
    lines.push(`Compliance level: ${ctx.investmentProfile.complianceLevel}`);
  }

  return {
    id: 'user-context',
    title: 'User Context',
    content: lines.join('\n'),
    priority: 70,
    required: false,
    tokenEstimate: lines.length * 10,
  };
}

function buildChannelContextSection(ctx: PromptBuildContext): PromptSection {
  const rules: Record<ChatType, string> = {
    direct: 'This is a direct message. Be personal and detailed in responses.',
    group: 'This is a group chat. Be concise and address the specific user.',
    channel: 'This is a broadcast channel. Keep responses professional and general.',
  };

  return {
    id: 'channel-context',
    title: 'Channel Context',
    content: rules[ctx.chatType],
    priority: 65,
    required: false,
    tokenEstimate: 20,
  };
}

function buildFormattingSection(): PromptSection {
  return {
    id: 'formatting',
    title: 'Response Formatting',
    content: [
      'Format guidelines:',
      '- Use tables for comparative data',
      '- Use bullet points for lists',
      '- Format numbers with appropriate precision (currency: 2 decimals, percentages: 2 decimals)',
      '- Use markdown for emphasis when needed',
    ].join('\n'),
    priority: 60,
    required: false,
    tokenEstimate: 40,
  };
}

function buildLanguageSection(): PromptSection {
  return {
    id: 'language',
    title: 'Language & Tone',
    content: [
      'Respond in the same language as the user message.',
      'Maintain a professional yet approachable tone.',
      'Avoid jargon when simpler terms suffice.',
    ].join('\n'),
    priority: 55,
    required: false,
    tokenEstimate: 25,
  };
}

function buildConstraintsSection(): PromptSection {
  return {
    id: 'constraints',
    title: 'Constraints',
    content: [
      'Constraints:',
      '- Do not fabricate financial data or statistics',
      '- Do not provide specific buy/sell recommendations',
      '- Do not access or share user personal financial data without explicit request',
      '- If uncertain about information accuracy, state so clearly',
    ].join('\n'),
    priority: 50,
    required: true,
    tokenEstimate: 40,
  };
}

function buildExamplesSection(): PromptSection {
  return {
    id: 'examples',
    title: 'Response Examples',
    content: '',
    priority: 45,
    required: false,
    tokenEstimate: 0,
  };
}

function buildCurrentStateSection(): PromptSection {
  const now = new Date();
  return {
    id: 'current-state',
    title: 'Current State',
    content: `Current date/time: ${now.toISOString()}`,
    priority: 40,
    required: false,
    tokenEstimate: 15,
  };
}

function buildMemorySection(): PromptSection {
  return {
    id: 'memory',
    title: 'Conversation Memory',
    content: '',
    priority: 35,
    required: false,
    tokenEstimate: 0,
  };
}

function buildCustomSection(instructions: string): PromptSection {
  return {
    id: 'custom',
    title: 'Custom Instructions',
    content: instructions,
    priority: 30,
    required: false,
    tokenEstimate: Math.ceil(instructions.length / 4), // 대략 4 chars per token
  };
}

// ── 메인 함수 ──

/**
 * 15+ 섹션 동적 시스템 프롬프트 빌더
 *
 * 섹션은 priority 내림차순으로 정렬되어 조립된다.
 * 빈 content 섹션은 건너뛴다.
 * mode='minimal'이면 identity + tools + constraints만 포함.
 * mode='none'이면 빈 문자열 반환.
 */
export function buildSystemPrompt(ctx: PromptBuildContext, mode: PromptBuildMode = 'full'): string {
  if (mode === 'none') {
    return '';
  }

  const complianceLevel = ctx.investmentProfile?.complianceLevel ?? 'retail';

  // 모든 섹션 생성
  const allSections: PromptSection[] = [
    buildIdentitySection(),
    buildCapabilitiesSection(ctx),
    buildToolsSection(ctx.availableTools),
    buildFinanceContextSection(),
    buildComplianceSection(complianceLevel),
    buildRiskDisclaimerSection(),
    buildUserContextSection(ctx),
    buildChannelContextSection(ctx),
    buildFormattingSection(),
    buildLanguageSection(),
    buildConstraintsSection(),
    buildExamplesSection(),
    buildCurrentStateSection(),
    buildMemorySection(),
  ];

  // custom instructions
  if (ctx.customInstructions) {
    allSections.push(buildCustomSection(ctx.customInstructions));
  }

  // mode 필터링
  let sections: PromptSection[];
  if (mode === 'minimal') {
    const minimalIds = new Set(['identity', 'tools', 'constraints']);
    sections = allSections.filter((s) => minimalIds.has(s.id));
  } else {
    sections = allSections;
  }

  // priority 내림차순 정렬
  sections.sort((a, b) => b.priority - a.priority);

  // 빈 content 섹션 제거
  sections = sections.filter((s) => s.content.length > 0);

  // 조립
  return sections.map((s) => `## ${s.title}\n\n${s.content}`).join('\n\n---\n\n');
}
