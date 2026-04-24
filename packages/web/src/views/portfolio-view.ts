// packages/web/src/views/portfolio-view.ts
import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  createFinanceClient,
  type AppGateway,
  type FinanceClient,
  type PortfolioSnapshot,
} from '../app-gateway.js';

@customElement('portfolio-view')
export class PortfolioView extends LitElement {
  static override styles = css`
    :host {
      display: block;
      padding: 16px;
    }
    h2 {
      margin: 0;
      font-size: 20px;
      color: var(--text-primary, #e6edf3);
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
    }
    .empty {
      padding: 32px;
      text-align: center;
      color: var(--text-secondary, #8b949e);
      border: 1px dashed var(--border, #30363d);
      border-radius: 8px;
    }
    .error {
      color: var(--red, #f85149);
      padding: 12px;
      border: 1px solid var(--red, #f85149);
      border-radius: 6px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      background: var(--bg-secondary, #161b22);
      border-radius: 8px;
      overflow: hidden;
    }
    th,
    td {
      padding: 10px 14px;
      text-align: left;
      border-bottom: 1px solid var(--border, #30363d);
    }
    th {
      color: var(--text-secondary, #8b949e);
      font-weight: 500;
      font-size: 12px;
      text-transform: uppercase;
    }
    td {
      color: var(--text-primary, #e6edf3);
    }
    td.numeric {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    .note {
      color: var(--text-secondary, #8b949e);
      font-size: 12px;
      margin-top: 12px;
    }
    button.refresh {
      padding: 6px 12px;
      background: transparent;
      color: var(--text-secondary, #8b949e);
      border: 1px solid var(--border, #30363d);
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
    }
  `;

  @property({ attribute: false })
  gateway!: AppGateway;

  @state() private snapshot: PortfolioSnapshot | null = null;
  @state() private loading = false;
  @state() private error = '';

  private client: FinanceClient | null = null;
  private loaded = false;

  override connectedCallback(): void {
    super.connectedCallback();
    if (this.gateway) {
      this.client = createFinanceClient(this.gateway);
      void this.load();
    }
  }

  override updated(): void {
    if (!this.client && this.gateway) {
      this.client = createFinanceClient(this.gateway);
      if (!this.loaded) {
        void this.load();
      }
    }
  }

  private async load(): Promise<void> {
    if (!this.client || !this.gateway?.isConnected) {
      return;
    }
    this.loaded = true;
    this.loading = true;
    this.error = '';
    try {
      this.snapshot = await this.client.portfolioGet();
    } catch (err) {
      this.error = (err as Error).message;
    } finally {
      this.loading = false;
    }
  }

  override render() {
    const holdings = this.snapshot?.holdings ?? [];

    return html`
      <div class="header">
        <h2>Portfolio${this.snapshot?.name ? ` — ${this.snapshot.name}` : ''}</h2>
        <button class="refresh" @click=${this.load} ?disabled=${this.loading}>
          ${this.loading ? '불러오는 중...' : '새로고침'}
        </button>
      </div>

      ${this.error ? html`<div class="error">${this.error}</div>` : ''}
      ${
        !this.gateway?.isConnected
          ? html`
              <div class="empty">게이트웨이 연결 대기 중...</div>
            `
          : this.loading && !this.snapshot
            ? html`
                <div class="empty">불러오는 중...</div>
              `
            : holdings.length === 0
              ? html`
                  <div class="empty">
                    포트폴리오에 종목이 없습니다.<br />
                    <span class="note">거래 기록·편집 기능은 Phase 25 에서 추가 예정입니다.</span>
                  </div>
                `
              : html`
                <table>
                  <thead>
                    <tr>
                      <th>Symbol</th>
                      <th>수량</th>
                      <th>평균단가</th>
                      <th>통화</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${holdings.map(
                      (h) => html`
                        <tr>
                          <td>${h.symbol}</td>
                          <td class="numeric">${h.quantity.toLocaleString()}</td>
                          <td class="numeric">${h.avgPrice.toLocaleString()}</td>
                          <td>${h.currency}</td>
                        </tr>
                      `,
                    )}
                  </tbody>
                </table>
                <div class="note">총 ${holdings.length}개 종목. 거래 이력은 Phase 25 예정.</div>
              `
      }
    `;
  }
}
