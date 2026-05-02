// packages/web/src/views/transaction-form.ts
// Phase 26 E: 거래 추가 in-place 모달 폼.
// 클라이언트 1차 검증(필수 필드/숫자/enum) → 서버 2차 검증(Zod). 실패 시 폼 입력 보존.

import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  createFinanceClient,
  type AppGateway,
  type FinanceClient,
  type TransactionAction,
  type TransactionAddResult,
} from '../app-gateway.js';

const ACTIONS: readonly TransactionAction[] = ['buy', 'sell', 'dividend', 'fee', 'split'];
const CURRENCIES: readonly string[] = ['USD', 'KRW', 'EUR', 'JPY', 'GBP', 'CNY', 'HKD'];

@customElement('transaction-form')
export class TransactionForm extends LitElement {
  static override styles = css`
    :host {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.55);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }
    .modal {
      width: min(480px, 92vw);
      background: var(--bg-secondary, #161b22);
      border: 1px solid var(--border, #30363d);
      border-radius: 10px;
      padding: 20px;
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }
    h3 {
      margin: 0;
      font-size: 17px;
      color: var(--text-primary, #e6edf3);
    }
    button.close {
      background: transparent;
      border: none;
      color: var(--text-secondary, #8b949e);
      font-size: 18px;
      cursor: pointer;
      padding: 0 4px;
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-bottom: 12px;
    }
    .field label {
      font-size: 12px;
      color: var(--text-secondary, #8b949e);
    }
    .field input,
    .field select,
    .field textarea {
      padding: 8px 10px;
      background: var(--bg-tertiary, #1c2129);
      color: var(--text-primary, #e6edf3);
      border: 1px solid var(--border, #30363d);
      border-radius: 6px;
      font-size: 14px;
      font-family: inherit;
      outline: none;
    }
    .field textarea {
      resize: vertical;
      min-height: 60px;
    }
    .row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 18px;
    }
    button.primary,
    button.secondary {
      padding: 8px 16px;
      border-radius: 6px;
      font-size: 14px;
      cursor: pointer;
      border: 1px solid var(--border, #30363d);
    }
    button.primary {
      background: var(--accent, #1f6feb);
      color: #fff;
      border-color: var(--accent, #1f6feb);
    }
    button.primary:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
    button.secondary {
      background: transparent;
      color: var(--text-primary, #e6edf3);
    }
    .error {
      color: var(--red, #f85149);
      padding: 8px 10px;
      border: 1px solid var(--red, #f85149);
      border-radius: 6px;
      font-size: 13px;
      margin-bottom: 10px;
    }
  `;

  @property({ attribute: false })
  gateway!: AppGateway;

  @state() private symbol = '';
  @state() private action: TransactionAction = 'buy';
  @state() private quantity = '';
  @state() private price = '';
  @state() private fee = '0';
  @state() private currency = 'USD';
  @state() private executedAt = todayIsoDate();
  @state() private note = '';
  @state() private error = '';
  @state() private submitting = false;

  private client: FinanceClient | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    if (this.gateway) {
      this.client = createFinanceClient(this.gateway);
    }
  }

  private dispatchClose(): void {
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }

  private onBackdrop(e: MouseEvent): void {
    if (e.target === this) {
      this.dispatchClose();
    }
  }

  private async onSubmit(e: Event): Promise<void> {
    e.preventDefault();
    if (!this.client) {
      this.error = '게이트웨이 미초기화';
      return;
    }
    const trimmedSymbol = this.symbol.trim();
    if (!trimmedSymbol) {
      this.error = '심볼을 입력해주세요';
      return;
    }
    const qty = Number.parseFloat(this.quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      this.error = '수량은 0 보다 큰 숫자여야 합니다';
      return;
    }
    let priceVal: number | undefined;
    if (this.price.trim() !== '') {
      const p = Number.parseFloat(this.price);
      if (!Number.isFinite(p) || p < 0) {
        this.error = '단가는 0 이상의 숫자여야 합니다';
        return;
      }
      priceVal = p;
    }
    if ((this.action === 'buy' || this.action === 'sell') && priceVal === undefined) {
      this.error = '매수/매도 거래는 단가가 필요합니다';
      return;
    }
    let feeVal = 0;
    if (this.fee.trim() !== '') {
      const f = Number.parseFloat(this.fee);
      if (!Number.isFinite(f) || f < 0) {
        this.error = '수수료는 0 이상의 숫자여야 합니다';
        return;
      }
      feeVal = f;
    }
    const executedAtMs = Date.parse(this.executedAt);
    if (!Number.isFinite(executedAtMs)) {
      this.error = '거래일이 올바르지 않습니다';
      return;
    }

    this.error = '';
    this.submitting = true;
    try {
      const params: Parameters<FinanceClient['transactionAdd']>[0] = {
        symbol: trimmedSymbol.toUpperCase(),
        action: this.action,
        quantity: qty,
        fee: feeVal,
        currency: this.currency,
        executedAt: executedAtMs,
      };
      if (priceVal !== undefined) {
        (params as { price?: number }).price = priceVal;
      }
      const trimmedNote = this.note.trim();
      if (trimmedNote) {
        (params as { note?: string }).note = trimmedNote;
      }
      const result: TransactionAddResult = await this.client.transactionAdd(params);
      this.dispatchEvent(
        new CustomEvent('transaction-added', {
          detail: result,
          bubbles: true,
          composed: true,
        }),
      );
      this.dispatchClose();
    } catch (err) {
      this.error = (err as Error).message;
    } finally {
      this.submitting = false;
    }
  }

  override render() {
    const needsPrice = this.action === 'buy' || this.action === 'sell';
    return html`
      <div @click=${this.onBackdrop} style="position:absolute;inset:0;"></div>
      <div class="modal" role="dialog" aria-labelledby="txn-form-title">
        <div class="header">
          <h3 id="txn-form-title">거래 추가</h3>
          <button type="button" class="close" @click=${this.dispatchClose} aria-label="닫기">
            ×
          </button>
        </div>

        ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : ''}

        <form @submit=${this.onSubmit}>
          <div class="field">
            <label for="txn-symbol">심볼 *</label>
            <input
              id="txn-symbol"
              type="text"
              required
              .value=${this.symbol}
              @input=${(e: Event) => (this.symbol = (e.target as HTMLInputElement).value)}
              placeholder="AAPL"
            />
          </div>

          <div class="row">
            <div class="field">
              <label for="txn-action">액션 *</label>
              <select
                id="txn-action"
                .value=${this.action}
                @change=${(e: Event) =>
                  (this.action = (e.target as HTMLSelectElement).value as TransactionAction)}
              >
                ${ACTIONS.map((a) => html`<option value=${a}>${a}</option>`)}
              </select>
            </div>
            <div class="field">
              <label for="txn-quantity">수량 *</label>
              <input
                id="txn-quantity"
                type="number"
                step="any"
                min="0"
                required
                .value=${this.quantity}
                @input=${(e: Event) => (this.quantity = (e.target as HTMLInputElement).value)}
              />
            </div>
          </div>

          <div class="row">
            <div class="field">
              <label for="txn-price">단가${needsPrice ? ' *' : ''}</label>
              <input
                id="txn-price"
                type="number"
                step="any"
                min="0"
                .value=${this.price}
                @input=${(e: Event) => (this.price = (e.target as HTMLInputElement).value)}
              />
            </div>
            <div class="field">
              <label for="txn-fee">수수료</label>
              <input
                id="txn-fee"
                type="number"
                step="any"
                min="0"
                .value=${this.fee}
                @input=${(e: Event) => (this.fee = (e.target as HTMLInputElement).value)}
              />
            </div>
          </div>

          <div class="row">
            <div class="field">
              <label for="txn-currency">통화</label>
              <select
                id="txn-currency"
                .value=${this.currency}
                @change=${(e: Event) => (this.currency = (e.target as HTMLSelectElement).value)}
              >
                ${CURRENCIES.map((c) => html`<option value=${c}>${c}</option>`)}
              </select>
            </div>
            <div class="field">
              <label for="txn-date">거래일 *</label>
              <input
                id="txn-date"
                type="date"
                required
                .value=${this.executedAt}
                @input=${(e: Event) => (this.executedAt = (e.target as HTMLInputElement).value)}
              />
            </div>
          </div>

          <div class="field">
            <label for="txn-note">노트</label>
            <textarea
              id="txn-note"
              .value=${this.note}
              @input=${(e: Event) => (this.note = (e.target as HTMLTextAreaElement).value)}
              maxlength="500"
            ></textarea>
          </div>

          <div class="actions">
            <button type="button" class="secondary" @click=${this.dispatchClose}>취소</button>
            <button type="submit" class="primary" ?disabled=${this.submitting}>
              ${this.submitting ? '저장 중...' : '추가'}
            </button>
          </div>
        </form>
      </div>
    `;
  }
}

function todayIsoDate(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
