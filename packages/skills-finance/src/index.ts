// packages/skills-finance/src/index.ts
export { registerMarketTools, MARKET_SKILL_METADATA } from './market/index.js';
export type { MarketSkillConfig, MarketSkillHandle } from './market/index.js';
export { registerNewsTools, NEWS_SKILL_METADATA } from './news/index.js';
export type { NewsSkillConfig, NewsSkillHandle, NewsAggregator } from './news/index.js';
export { registerAlertTools, ALERT_SKILL_METADATA } from './alerts/index.js';
export type { AlertSkillConfig } from './alerts/index.js';
