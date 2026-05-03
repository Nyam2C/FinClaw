// packages/web/src/views/schedule-form.ts
// Phase 28 D: schedule 등록 모달.

import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  createScheduleClient,
  type AppGateway,
  type DeliveryChannel,
  type ScheduleClient,
} from '../app-gateway.js';

const PRESETS: ReadonlyArray<{ label: string; cron: string }> = [
  { label: '매시간 정각', cron: '0 * * * *' },
  { label: '매일 9시', cron: '0 9 * * *' },
  { label: '매일 12시', cron: '0 12 * * *' },
  { label: '매주 월 9시', cron: '0 9 * * 1' },
];

@customElement('schedule-form')
export class ScheduleForm extends LitElement {
  static override styles = css`
    :host {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.6);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 100;
    }
    .modal {
      background: var(--bg-secondary, #161b22);
      color: var(--text-primary, #e6edf3);
      border: 1px solid var(--border, #30363d);
      border-radius: 8px;
      padding: 20px;
      width: 520px;
      max-width: 90vw;
      max-height: 90vh;
      overflow-y: auto;
    }
    h3 {
      margin: 0 0 12px;
    }
    label {
      display: block;
      font-size: 12px;
      color: var(--text-secondary, #8b949e);
      margin-top: 12px;
      margin-bottom: 4px;
    }
    input,
    select,
    textarea {
      width: 100%;
      padding: 6px 10px;
      background: var(--bg-tertiary, #1c2129);
      color: var(--text-primary, #e6edf3);
      border: 1px solid var(--border, #30363d);
      border-radius: 6px;
      font-size: 13px;
      font-family: inherit;
      outline: none;
      box-sizing: border-box;
    }
    textarea {
      min-height: 80px;
      resize: vertical;
    }
    .presets {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      margin-top: 4px;
    }
    .preset {
      padding: 3px 8px;
      font-size: 11px;
      background: transparent;
      color: var(--text-primary, #e6edf3);
      border: 1px solid var(--border, #30363d);
      border-radius: 4px;
      cursor: pointer;
    }
    .preset:hover {
      background: var(--bg-tertiary, #1c2129);
    }
    .preview {
      margin-top: 6px;
      font-size: 11px;
      color: var(--text-secondary, #8b949e);
      min-height: 14px;
    }
    .error {
      color: var(--red, #f85149);
      font-size: 12px;
      margin-top: 8px;
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 16px;
    }
    button.primary {
      padding: 6px 14px;
      background: var(--blue, #2f81f7);
      color: white;
      border: 0;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
    }
    button.primary:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    button.secondary {
      padding: 6px 14px;
      background: transparent;
      color: var(--text-primary, #e6edf3);
      border: 1px solid var(--border, #30363d);
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
    }
  `;

  @property({ attribute: false }) gateway!: AppGateway;

  @state() private name = '';
  @state() private cron = '0 12 * * *';
  @state() private agentId = 'finclaw-partner';
  @state() private prompt = '';
  @state() private deliveryChannel: DeliveryChannel = 'web';
  @state() private deliveryTarget = 'broadcast';
  @state() private cronPreview = '';
  @state() private cronError = '';
  @state() private submitting = false;
  @state() private error = '';

  private client: ScheduleClient | null = null;
  private cronDebounce: ReturnType<typeof setTimeout> | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this.client = createScheduleClient(this.gateway);
    void this.refreshPreview();
  }

  private async refreshPreview(): Promise<void> {
    if (!this.client) {
      return;
    }
    try {
      const res = await this.client.testCron(this.cron, 3);
      this.cronPreview = res.nextRunsAt
        .map((ms) => new Date(ms).toLocaleString('ko-KR'))
        .join(' · ');
      this.cronError = '';
    } catch (err) {
      this.cronPreview = '';
      this.cronError = (err as Error).message;
    }
  }

  private onCronChange(e: Event): void {
    this.cron = (e.target as HTMLInputElement).value;
    if (this.cronDebounce) {
      clearTimeout(this.cronDebounce);
    }
    this.cronDebounce = setTimeout(() => void this.refreshPreview(), 250);
  }

  private applyPreset(c: string): void {
    this.cron = c;
    void this.refreshPreview();
  }

  private onChannelChange(e: Event): void {
    this.deliveryChannel = (e.target as HTMLSelectElement).value as DeliveryChannel;
    if (this.deliveryChannel === 'web') {
      this.deliveryTarget = 'broadcast';
    }
  }

  private async onSubmit(): Promise<void> {
    if (!this.client) {
      return;
    }
    if (!this.name.trim() || !this.prompt.trim() || this.cronError) {
      return;
    }
    this.submitting = true;
    this.error = '';
    try {
      await this.client.create({
        name: this.name.trim(),
        cron: this.cron.trim(),
        agentId: this.agentId,
        prompt: this.prompt,
        deliveryChannel: this.deliveryChannel,
        deliveryTarget: this.deliveryChannel === 'web' ? 'broadcast' : this.deliveryTarget.trim(),
      });
      this.dispatchEvent(new CustomEvent('schedule-created', { bubbles: true, composed: true }));
    } catch (err) {
      this.error = (err as Error).message;
    } finally {
      this.submitting = false;
    }
  }

  private onClose(): void {
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }

  override render() {
    return html`
      <div class="modal" role="dialog" aria-label="자동화 추가">
        <h3>자동화 추가</h3>

        <label>이름</label>
        <input
          .value=${this.name}
          @input=${(e: Event) => (this.name = (e.target as HTMLInputElement).value)}
          placeholder="예: 일일 포트폴리오 보고"
        />

        <label>cron (분 시 일 월 요일)</label>
        <input .value=${this.cron} @input=${this.onCronChange} placeholder="0 12 * * *" />
        <div class="presets">
          ${PRESETS.map(
            (p) => html`<button
              type="button"
              class="preset"
              @click=${() => this.applyPreset(p.cron)}
            >
              ${p.label}
            </button>`,
          )}
        </div>
        <div class="preview">${this.cronError ? '' : `다음 실행: ${this.cronPreview || '-'}`}</div>
        ${this.cronError ? html`<div class="error">${this.cronError}</div>` : ''}

        <label>agent</label>
        <input
          .value=${this.agentId}
          @input=${(e: Event) => (this.agentId = (e.target as HTMLInputElement).value)}
          placeholder="finclaw-partner"
        />

        <label>prompt</label>
        <textarea
          .value=${this.prompt}
          @input=${(e: Event) => (this.prompt = (e.target as HTMLTextAreaElement).value)}
          placeholder="자동 실행 시 보낼 prompt"
          maxlength="2000"
        ></textarea>

        <label>송출 채널</label>
        <select .value=${this.deliveryChannel} @change=${this.onChannelChange}>
          <option value="web">Web 알림</option>
          <option value="discord">Discord DM</option>
        </select>

        ${this.deliveryChannel === 'discord'
          ? html`
              <label>Discord user_id 또는 channel_id</label>
              <input
                .value=${this.deliveryTarget}
                @input=${(e: Event) => (this.deliveryTarget = (e.target as HTMLInputElement).value)}
                placeholder="123456789012345678"
              />
            `
          : ''}
        ${this.error ? html`<div class="error">${this.error}</div>` : ''}

        <div class="actions">
          <button class="secondary" @click=${this.onClose}>취소</button>
          <button
            class="primary"
            ?disabled=${this.submitting ||
            !this.name.trim() ||
            !this.prompt.trim() ||
            !!this.cronError}
            @click=${this.onSubmit}
          >
            ${this.submitting ? '저장 중...' : '저장'}
          </button>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'schedule-form': ScheduleForm;
  }
}
