// packages/web/src/views/portfolio-view.ts
// Phase 26 E: 보유 종목 탭(기존 유지) + 거래 이력 탭(신설) + portfolio.changed 자동 갱신.

import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  createFinanceClient,
  type AppGateway,
  type FinanceClient,
  type NotificationHandler,
  type PortfolioSnapshot,
  type Transaction,
} from '../app-gateway.js';

type PortfolioTab = 'holdings' | 'transactions';

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
      margin-bottom: 12px;
    }
    .tabs {
      display: flex;
      gap: 4px;
      margin-bottom: 12px;
      border-bottom: 1px solid var(--border, #30363d);
    }
    .tabs button {
      padding: 8px 14px;
      background: transparent;
      color: var(--text-secondary, #8b949e);
      border: none;
      border-bottom: 2px solid transparent;
      cursor: pointer;
      font-size: 14px;
    }
    .tabs button[aria-selected='true'] {
      color: var(--text-primary, #e6edf3);
      border-bottom-color: var(--accent, #1f6feb);
    }
    .empty {
      padding: 32px;
      text-align: center;
      color: var(--text-secondary, #8b949e);
      border: 1px dashed var(--border, #30363d);
      border-radius: 8px;
    }
    .error,
    .toast {
      color: var(--red, #f85149);
      padding: 8px 12px;
      border: 1px solid var(--red, #f85149);
      border-radius: 6px;
      margin-bottom: 8px;
    }
    .toast {
      color: var(--text-primary, #e6edf3);
      border-color: var(--accent, #1f6feb);
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
      font-size: 13px;
    }
    td.numeric {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    td.note {
      color: var(--text-secondary, #8b949e);
      max-width: 200px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .row-actions {
      display: flex;
      gap: 6px;
      justify-content: flex-end;
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
    button.add {
      padding: 6px 12px;
      background: var(--accent, #1f6feb);
      color: #fff;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
    }
    button.danger {
      padding: 4px 10px;
      background: transparent;
      color: var(--red, #f85149);
      border: 1px solid var(--red, #f85149);
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
    }
    .toolbar {
      display: flex;
      gap: 8px;
      margin-bottom: 12px;
    }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      text-transform: uppercase;
      background: var(--bg-tertiary, #1c2129);
      color: var(--text-primary, #e6edf3);
    }
    .badge.buy {
      background: rgba(63, 185, 80, 0.15);
      color: var(--green, #3fb950);
    }
    .badge.sell {
      background: rgba(248, 81, 73, 0.15);
      color: var(--red, #f85149);
    }
    .badge.dividend,
    .badge.fee,
    .badge.split {
      background: rgba(31, 111, 235, 0.18);
      color: var(--accent, #1f6feb);
    }
  `;

  @property({ attribute: false })
  gateway!: AppGateway;

  @state() private snapshot: PortfolioSnapshot | null = null;
  @state() private transactions: readonly Transaction[] = [];
  @state() private loading = false;
  @state() private error = '';
  @state() private showForm = false;
  @state() private activeTab: PortfolioTab = 'holdings';
  @state() private deleteWaiting = false;

  private client: FinanceClient | null = null;
  private loaded = false;
  private notificationHandler: NotificationHandler | null = null;
  private deleteWaitTimer: ReturnType<typeof setTimeout> | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    if (this.gateway) {
      this.attach();
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.notificationHandler && this.gateway) {
      this.gateway.offNotification(this.notificationHandler);
      this.notificationHandler = null;
    }
    if (this.deleteWaitTimer) {
      clearTimeout(this.deleteWaitTimer);
      this.deleteWaitTimer = null;
    }
  }

  override updated(): void {
    if (!this.client && this.gateway) {
      this.attach();
    }
  }

  private attach(): void {
    this.client = createFinanceClient(this.gateway);
    if (!this.notificationHandler) {
      this.notificationHandler = (method) => {
        if (method === 'notification.portfolio.changed') {
          // 다른 채널에서 transactions 변경 시 자동 재로드.
          if (this.deleteWaitTimer) {
            clearTimeout(this.deleteWaitTimer);
            this.deleteWaitTimer = null;
            this.deleteWaiting = false;
          }
          void this.load();
        }
      };
      this.gateway.onNotification(this.notificationHandler);
    }
    if (!this.loaded) {
      void this.load();
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
      // recentTransactions 가 있으면 사용, 없거나 짧으면 별도 list 호출.
      const recent = this.snapshot.recentTransactions ?? [];
      if (recent.length >= 10) {
        this.transactions = recent;
      } else if (this.snapshot.portfolioId) {
        const res = await this.client.transactionList({
          portfolioId: this.snapshot.portfolioId,
          limit: 50,
        });
        this.transactions = res.transactions;
      } else {
        this.transactions = recent;
      }
    } catch (err) {
      this.error = (err as Error).message;
    } finally {
      this.loading = false;
    }
  }

  private setTab(tab: PortfolioTab): void {
    this.activeTab = tab;
  }

  private openForm(): void {
    this.showForm = true;
  }

  private closeForm(): void {
    this.showForm = false;
  }

  private onTransactionAdded(): void {
    // portfolio.changed broadcast 가 자동으로 load() 를 트리거하므로 별도 호출 불필요.
    // 다만 broadcaster 미설정 환경에서도 동작하도록 안전하게 1회 갱신.
    void this.load();
  }

  private async onDelete(txn: Transaction): Promise<void> {
    if (!this.client) {
      return;
    }
    const confirmed = window.confirm(
      `${txn.symbol} ${txn.action} ${txn.quantity} 거래를 삭제하시겠습니까?\n삭제 후 holdings 가 재계산됩니다.`,
    );
    if (!confirmed) {
      return;
    }
    this.error = '';
    try {
      await this.client.transactionDelete({ transactionId: txn.id });
      // 5초 안에 portfolio.changed 가 안 오면 수동 재로드 안내.
      this.deleteWaiting = true;
      this.deleteWaitTimer = setTimeout(() => {
        if (this.deleteWaiting) {
          this.deleteWaiting = false;
          void this.load();
        }
      }, 5000);
    } catch (err) {
      this.error = (err as Error).message;
    }
  }

  private renderHoldings() {
    const holdings = this.snapshot?.holdings ?? [];
    if (holdings.length === 0) {
      return html`<div class="empty">포트폴리오에 종목이 없습니다.</div>`;
    }
    return html`
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
    `;
  }

  private renderTransactions() {
    const txns = this.transactions;
    return html`
      <div class="toolbar">
        <button class="add" @click=${this.openForm} ?disabled=${!this.gateway?.isConnected}>
          + 거래 추가
        </button>
      </div>

      ${this.deleteWaiting
        ? html`<div class="toast">삭제 처리 중... (5초 내 갱신 없으면 수동 새로고침 권장)</div>`
        : ''}
      ${txns.length === 0
        ? html`<div class="empty">거래 이력이 없습니다.</div>`
        : html`
            <table>
              <thead>
                <tr>
                  <th>날짜</th>
                  <th>심볼</th>
                  <th>액션</th>
                  <th>수량</th>
                  <th>단가</th>
                  <th>금액</th>
                  <th>노트</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${txns.map((t) => {
                  const amount =
                    t.price !== undefined && t.price !== null
                      ? (t.quantity * t.price).toLocaleString()
                      : '-';
                  const date = new Date(t.executedAt).toLocaleDateString();
                  return html`
                    <tr>
                      <td>${date}</td>
                      <td>${t.symbol}</td>
                      <td><span class="badge ${t.action}">${t.action}</span></td>
                      <td class="numeric">${t.quantity.toLocaleString()}</td>
                      <td class="numeric">
                        ${t.price !== undefined && t.price !== null
                          ? t.price.toLocaleString()
                          : '-'}
                      </td>
                      <td class="numeric">${amount}</td>
                      <td class="note" title=${t.note ?? ''}>${t.note ?? ''}</td>
                      <td>
                        <div class="row-actions">
                          <button class="danger" @click=${() => this.onDelete(t)}>삭제</button>
                        </div>
                      </td>
                    </tr>
                  `;
                })}
              </tbody>
            </table>
          `}
    `;
  }

  override render() {
    return html`
      <div class="header">
        <h2>Portfolio${this.snapshot?.name ? ` — ${this.snapshot.name}` : ''}</h2>
        <button class="refresh" @click=${this.load} ?disabled=${this.loading}>
          ${this.loading ? '불러오는 중...' : '새로고침'}
        </button>
      </div>

      <div class="tabs" role="tablist">
        <button
          role="tab"
          aria-selected=${this.activeTab === 'holdings' ? 'true' : 'false'}
          @click=${() => this.setTab('holdings')}
        >
          보유 종목
        </button>
        <button
          role="tab"
          aria-selected=${this.activeTab === 'transactions' ? 'true' : 'false'}
          @click=${() => this.setTab('transactions')}
        >
          거래 이력
        </button>
      </div>

      ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : ''}
      ${!this.gateway?.isConnected
        ? html`<div class="empty">게이트웨이 연결 대기 중...</div>`
        : this.loading && !this.snapshot
          ? html`<div class="empty">불러오는 중...</div>`
          : this.activeTab === 'holdings'
            ? this.renderHoldings()
            : this.renderTransactions()}
      ${this.showForm
        ? html`
            <transaction-form
              .gateway=${this.gateway}
              @close=${this.closeForm}
              @transaction-added=${this.onTransactionAdded}
            ></transaction-form>
          `
        : ''}
    `;
  }
}
