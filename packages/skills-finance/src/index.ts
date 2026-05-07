// packages/skills-finance/src/index.ts
export { registerMarketTools, MARKET_SKILL_METADATA } from './market/index.js';
export type { MarketSkillConfig, MarketSkillHandle } from './market/index.js';
export { registerNewsTools, NEWS_SKILL_METADATA } from './news/index.js';
export type {
  NewsSkillConfig,
  NewsSkillHandle,
  NewsAggregator,
  QuoteService,
} from './news/index.js';
export { PortfolioStore } from './news/portfolio/store.js';
export { registerAlertTools, ALERT_SKILL_METADATA } from './alerts/index.js';
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
