// packages/web/src/views/alerts-view.ts
import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  createFinanceClient,
  type AlertConditionId,
  type AppGateway,
  type FinanceAlert,
  type FinanceClient,
} from '../app-gateway.js';

@customElement('alerts-view')
export class AlertsView extends LitElement {
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
      flex-wrap: wrap;
      margin-bottom: 16px;
      padding: 12px;
      background: var(--bg-secondary, #161b22);
      border: 1px solid var(--border, #30363d);
      border-radius: 8px;
    }
    input,
    select {
      padding: 6px 10px;
      background: var(--bg-tertiary, #1c2129);
      color: var(--text-primary, #e6edf3);
      border: 1px solid var(--border, #30363d);
      border-radius: 6px;
      font-size: 14px;
      outline: none;
    }
    input:focus,
    select:focus {
      border-color: var(--accent, #1f6feb);
    }
    button {
      padding: 6px 14px;
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
    .triggered {
      color: var(--green, #3fb950);
      font-size: 13px;
      padding: 8px 12px;
      border: 1px solid var(--green, #3fb950);
      border-radius: 6px;
      margin-bottom: 8px;
    }
    .error {
      color: var(--red, #f85149);
      padding: 8px 12px;
      border: 1px solid var(--red, #f85149);
      border-radius: 6px;
      margin-bottom: 8px;
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
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      background: var(--accent, #1f6feb);
      color: #fff;
    }
    .badge.off {
      background: var(--text-secondary, #8b949e);
    }
    .empty {
      padding: 24px;
      text-align: center;
      color: var(--text-secondary, #8b949e);
      border: 1px dashed var(--border, #30363d);
      border-radius: 8px;
    }
    .hint {
      color: var(--text-secondary, #8b949e);
      font-size: 12px;
      margin-top: 12px;
    }
  `;

  @property({ attribute: false })
  gateway!: AppGateway;

  @state() private alerts: readonly FinanceAlert[] = [];
  @state() private loading = false;
  @state() private error = '';
  @state() private triggerMsg = '';

  @state() private symbol = '';
  @state() private condition: AlertConditionId = 'price_above';
  @state() private threshold = '';
  @state() private keyword = '';

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
      const res = await this.client.alertList();
      this.alerts = res.alerts;
    } catch (err) {
      this.error = (err as Error).message;
    } finally {
      this.loading = false;
    }
  }

  private async onSubmit(e: Event): Promise<void> {
    e.preventDefault();
    if (!this.client || !this.symbol.trim()) {
      return;
    }
    this.error = '';
    this.triggerMsg = '';
    try {
      const params: Parameters<FinanceClient['alertCreate']>[0] = {
        symbol: this.symbol.trim().toUpperCase(),
        condition: this.condition,
      };
      if (this.condition === 'news_match') {
        if (!this.keyword.trim()) {
          this.error = '키워드를 입력해주세요';
          return;
        }
        params.keyword = this.keyword.trim();
      } else {
        const t = parseFloat(this.threshold);
        if (!Number.isFinite(t)) {
          this.error = '임계값을 숫자로 입력해주세요';
          return;
        }
        params.threshold = t;
      }
      const res = await this.client.alertCreate(params);
      if (res.immediateTrigger) {
        this.triggerMsg = `이미 조건 충족 — 즉시 알림 발사됨 (#${res.alertId})`;
      }
      this.symbol = '';
      this.threshold = '';
      this.keyword = '';
      await this.load();
    } catch (err) {
      this.error = (err as Error).message;
    }
  }

  private renderConditionLabel(c: string): string {
    switch (c) {
      case 'price_above':
        return '가격 상향';
      case 'price_below':
        return '가격 하향';
      case 'change_percent':
        return '변동률';
      case 'news_match':
        return '뉴스 키워드';
      case 'volume':
        return '거래량';
      default:
        return c;
    }
  }

  override render() {
    return html`
      <h2>Alerts</h2>

      <form @submit=${this.onSubmit}>
        <input
          type="text"
          placeholder="Symbol"
          .value=${this.symbol}
          @input=${(e: Event) => (this.symbol = (e.target as HTMLInputElement).value)}
        />
        <select
          .value=${this.condition}
          @change=${(e: Event) =>
            (this.condition = (e.target as HTMLSelectElement).value as AlertConditionId)}
        >
          <option value="price_above">가격 상향</option>
          <option value="price_below">가격 하향</option>
          <option value="change_percent">변동률 (%)</option>
          <option value="news_match">뉴스 키워드</option>
        </select>
        ${
          this.condition === 'news_match'
            ? html`<input
              type="text"
              placeholder="키워드"
              .value=${this.keyword}
              @input=${(e: Event) => (this.keyword = (e.target as HTMLInputElement).value)}
            />`
            : html`<input
              type="number"
              step="0.01"
              placeholder="임계값"
              .value=${this.threshold}
              @input=${(e: Event) => (this.threshold = (e.target as HTMLInputElement).value)}
            />`
        }
        <button type="submit" ?disabled=${!this.gateway?.isConnected}>추가</button>
      </form>

      ${this.triggerMsg ? html`<div class="triggered">${this.triggerMsg}</div>` : ''}
      ${this.error ? html`<div class="error">${this.error}</div>` : ''}

      ${
        this.loading
          ? html`
              <div class="empty">불러오는 중...</div>
            `
          : this.alerts.length === 0
            ? html`
                <div class="empty">설정된 알림 없음</div>
              `
            : html`
              <table>
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>조건</th>
                    <th>임계값/키워드</th>
                    <th>상태</th>
                    <th>트리거</th>
                    <th>생성일</th>
                  </tr>
                </thead>
                <tbody>
                  ${this.alerts.map(
                    (a) => html`
                      <tr>
                        <td>${a.symbol}</td>
                        <td>${this.renderConditionLabel(a.condition)}</td>
                        <td>${a.threshold ?? a.keyword ?? '-'}</td>
                        <td>
                          <span class="badge ${a.enabled ? '' : 'off'}">
                            ${a.enabled ? '활성' : '비활성'}
                          </span>
                        </td>
                        <td>${a.triggerCount}회</td>
                        <td>${new Date(a.createdAt).toLocaleDateString()}</td>
                      </tr>
                    `,
                  )}
                </tbody>
              </table>
            `
      }

      <div class="hint">
        알림 삭제는 채팅에서 <code>!finclaw</code> 로 요청하세요 (Web 삭제는 Phase 24+ 예정).
      </div>
    `;
  }
}
