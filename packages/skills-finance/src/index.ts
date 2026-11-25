// packages/skills-finance/src/index.ts
export { createMarketSkill } from './market/index.js';
export type { MarketSkillConfig, MarketSkillHandle, ChartService } from './market/index.js';
export { createNewsSkill } from './news/index.js';
export type {
  NewsSkillConfig,
  NewsSkillHandle,
  NewsAggregator,
  QuoteService,
} from './news/index.js';
export { PortfolioStore } from './news/portfolio/store.js';
export { createPortfolioTracker } from './news/portfolio/tracker.js';
export { analyzeMarket } from './news/analysis/market-analysis.js';
export type { AnalysisOptions, MarketAnalysis } from './news/types.js';
export { registerAlertTools } from './alerts/index.js';
export type {
  AlertSkillConfig,
  AlertSkillHandle,
  AlertStore,
  AlertCondition,
  AlertDefinition,
  CreateAlertInput,
} from './alerts/index.js';
export {
  KeyRotator,
  AllKeysCooldownError,
  readKeyArray,
  type KeyRotatorOptions,
} from './shared/key-rotator.js';
// Phase 41: brokerage barrel 경유 (BrokerageClient/BrokerageProvider 포함).
export * from './brokerage/index.js';
