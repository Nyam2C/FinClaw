import type { MarketQuote, NewsItem, Alert } from '@finclaw/types';
import { EmbedBuilder } from 'discord.js';

/** 시세 임베드 — MarketQuote 사용 (MarketQuoteData 아님) */
export function buildMarketEmbed(quote: MarketQuote, instrumentName?: string): EmbedBuilder {
  const isPositive = quote.change >= 0;
  const arrow = isPositive ? '▲' : '▼';
  const color = isPositive ? 0x00c853 : 0xff1744;

  // Discord 제한: 제목 256자, 설명 4096자, field value 1024자
  const title = truncate(`${quote.symbol}${instrumentName ? ` - ${instrumentName}` : ''}`, 256);

  return new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .addFields(
      { name: '현재가', value: `**${formatCurrency(quote.price)}**`, inline: true },
      {
        name: '변동',
        value: `${arrow} ${formatCurrency(Math.abs(quote.change))} (${quote.changePercent.toFixed(2)}%)`,
        inline: true,
      },
      { name: '거래량', value: formatNumber(quote.volume), inline: true },
    )
    .addFields(
      ...(quote.marketCap
        ? [{ name: '시가총액', value: formatLargeNumber(quote.marketCap), inline: true }]
        : []),
    )
    .setFooter({ text: `마지막 업데이트: ${String(quote.timestamp)}` })
    .setTimestamp();
}

/** 뉴스 임베드 — NewsItem 사용 (NewsArticleData 아님) */
export function buildNewsEmbed(article: NewsItem): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(truncate(article.title, 256))
    .setURL(article.url)
    .setColor(0x1565c0)
    .addFields(
      { name: '출처', value: article.source, inline: true },
      { name: '발행일', value: String(article.publishedAt), inline: true },
    );

  // summary는 optional — null 체크
  if (article.summary) {
    embed.setDescription(truncate(article.summary, 4096));
  }

  // sentiment는 중첩 객체: sentiment.label
  if (article.sentiment) {
    embed.addFields({
      name: '감성',
      value: `${article.sentiment.label} (${(article.sentiment.confidence * 100).toFixed(0)}%)`,
      inline: true,
    });
  }

  if (article.symbols?.length) {
    embed.addFields({ name: '관련 종목', value: article.symbols.join(', ') });
  }

  return embed;
}

/** 알림 임베드 — Alert 사용 (AlertData 아님) */
export function buildAlertEmbed(alert: Alert): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(truncate(`알림: ${alert.symbol}`, 256))
    .setColor(alert.lastTriggeredAt ? 0xff9800 : 0x9e9e9e)
    .addFields(
      {
        name: '조건',
        value: `${alert.condition.type} ${alert.condition.value}${alert.condition.field ? ` (${alert.condition.field})` : ''}`,
        inline: true,
      },
      { name: '상태', value: alert.enabled ? '활성' : '비활성', inline: true },
      { name: '트리거 횟수', value: String(alert.triggerCount), inline: true },
    )
    .setFooter({ text: `ID: ${alert.id}` });
}

/** 에러 임베드 */
export function buildErrorEmbed(message: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('오류 발생')
    .setDescription(truncate(message, 4096))
    .setColor(0xff1744)
    .setTimestamp();
}

// --- 유틸리티 ---

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function formatCurrency(value: number): string {
  return value.toLocaleString('ko-KR', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function formatNumber(value: number): string {
  return value.toLocaleString('ko-KR');
}

function formatLargeNumber(value: number): string {
  if (value >= 1e12) {
    return `${(value / 1e12).toFixed(1)}조`;
  }
  if (value >= 1e8) {
    return `${(value / 1e8).toFixed(1)}억`;
  }
  if (value >= 1e4) {
    return `${(value / 1e4).toFixed(1)}만`;
  }
  return formatNumber(value);
}
