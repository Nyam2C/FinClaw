// packages/web/src/views/market-view.ts
import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  createFinanceClient,
  type AppGateway,
  type FinanceClient,
  type FinanceQuote,
} from '../app-gateway.js';

@customElement('market-view')
export class MarketView extends LitElement {
  static override styles = css`
    :host {
      display: block;
      padding: 16px;
    }
    h2 {
      margin: 0 0 16px;
      font-size: 20px;
      color: var(--text-primary, #e6edf3);
    }
    form {
      display: flex;
      gap: 8px;
      margin-bottom: 16px;
    }
    input {
      flex: 1;
      padding: 8px 12px;
      background: var(--bg-tertiary, #1c2129);
      color: var(--text-primary, #e6edf3);
      border: 1px solid var(--border, #30363d);
      border-radius: 6px;
      font-size: 14px;
      outline: none;
    }
    input:focus {
      border-color: var(--accent, #1f6feb);
    }
    button {
      padding: 8px 16px;
      background: var(--accent, #1f6feb);
      color: #fff;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .card {
      border: 1px solid var(--border, #30363d);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 8px;
      background: var(--bg-secondary, #161b22);
    }
    .symbol {
      font-size: 18px;
      font-weight: 600;
      color: var(--text-primary, #e6edf3);
    }
    .price {
      font-size: 24px;
      font-weight: 600;
      margin-top: 4px;
    }
    .up {
      color: var(--green, #3fb950);
    }
    .down {
      color: var(--red, #f85149);
    }
    .meta {
      color: var(--text-secondary, #8b949e);
      font-size: 12px;
      margin-top: 6px;
    }
    .error {
      color: var(--red, #f85149);
      padding: 12px;
      border: 1px solid var(--red, #f85149);
      border-radius: 6px;
      margin-bottom: 8px;
    }
    .hint {
      color: var(--text-secondary, #8b949e);
      font-size: 13px;
      margin-bottom: 8px;
    }
  `;

  @property({ attribute: false })
  gateway!: AppGateway;

  @state() private symbolInput = '';
  @state() private quotes: FinanceQuote[] = [];
  @state() private loading = false;
  @state() private error = '';

  private client: FinanceClient | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    if (this.gateway) {
      this.client = createFinanceClient(this.gateway);
    }
  }

  private async onSubmit(e: Event): Promise<void> {
    e.preventDefault();
    const symbol = this.symbolInput.trim();
    if (!symbol || !this.client) {
      return;
    }
    this.loading = true;
    this.error = '';
    try {
      const quote = await this.client.quote({ symbol });
      this.quotes = [quote, ...this.quotes.filter((q) => q.symbol !== quote.symbol)].slice(0, 5);
      this.symbolInput = '';
    } catch (err) {
      this.error = (err as Error).message || '조회 실패';
    } finally {
      this.loading = false;
    }
  }

  private onInput(e: Event): void {
    this.symbolInput = (e.target as HTMLInputElement).value;
  }

  override render() {
    return html`
      <h2>Market</h2>
      <form @submit=${this.onSubmit}>
        <input
          type="text"
          placeholder="Symbol (AAPL / BTC / USD/KRW)"
          .value=${this.symbolInput}
          @input=${this.onInput}
          ?disabled=${!this.gateway?.isConnected}
        />
        <button type="submit" ?disabled=${this.loading || !this.gateway?.isConnected}>
          ${this.loading ? '조회 중...' : '조회'}
        </button>
      </form>

      ${!this.gateway?.isConnected
        ? html` <div class="hint">게이트웨이 연결 대기 중...</div> `
        : ''}
      ${this.error ? html`<div class="error">${this.error}</div>` : ''}
      ${this.quotes.map(
        (q) => html`
          <div class="card">
            <div class="symbol">${q.symbol}</div>
            <div class="price ${q.change >= 0 ? 'up' : 'down'}">
              ${q.price.toLocaleString()}
              <span style="font-size: 14px; margin-left: 8px;">
                ${q.change >= 0 ? '+' : ''}${q.change.toFixed(2)} (${q.changePercent.toFixed(2)}%)
              </span>
            </div>
            <div class="meta">${new Date(q.timestamp).toLocaleTimeString()}</div>
          </div>
        `,
      )}
    `;
  }
}
