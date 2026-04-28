// packages/web/src/views/settings-view.ts
// Phase 26 E: 기억 관리 + 에이전트 실행 이력 + (placeholder) 라우팅 통계.
// 명시적 새로고침. portfolio.changed 자동 갱신은 본 뷰 범위 외.

import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  createAgentRunsClient,
  createMemoryClient,
  type AgentRunFull,
  type AgentRunSummary,
  type AgentRunsClient,
  type AppGateway,
  type Memory,
  type MemoryClient,
  type MemoryType,
} from '../app-gateway.js';

const MEMORY_TYPES: ReadonlyArray<{ value: '' | MemoryType; label: string }> = [
  { value: '', label: '전체' },
  { value: 'preference', label: 'preference' },
  { value: 'fact', label: 'fact' },
  { value: 'financial', label: 'financial' },
  { value: 'summary', label: 'summary' },
];

@customElement('settings-view')
export class SettingsView extends LitElement {
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
    section {
      margin-bottom: 28px;
    }
    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 10px;
    }
    h3 {
      margin: 0;
      font-size: 16px;
      color: var(--text-primary, #e6edf3);
    }
    .controls {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    select,
    button {
      padding: 6px 10px;
      background: var(--bg-tertiary, #1c2129);
      color: var(--text-primary, #e6edf3);
      border: 1px solid var(--border, #30363d);
      border-radius: 6px;
      font-size: 13px;
      cursor: pointer;
      outline: none;
    }
    button.refresh {
      color: var(--text-secondary, #8b949e);
      background: transparent;
    }
    button.danger {
      color: var(--red, #f85149);
      border-color: var(--red, #f85149);
      background: transparent;
      padding: 4px 10px;
      font-size: 12px;
    }
    .empty,
    .placeholder {
      padding: 24px;
      text-align: center;
      color: var(--text-secondary, #8b949e);
      border: 1px dashed var(--border, #30363d);
      border-radius: 8px;
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
      font-size: 13px;
    }
    th {
      color: var(--text-secondary, #8b949e);
      font-weight: 500;
      font-size: 11px;
      text-transform: uppercase;
    }
    td.content {
      max-width: 480px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      color: var(--text-primary, #e6edf3);
    }
    td.numeric {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    tr.run-row {
      cursor: pointer;
    }
    tr.run-row:hover {
      background: var(--bg-tertiary, #1c2129);
    }
    tr.expanded {
      background: var(--bg-tertiary, #1c2129);
    }
    .detail {
      padding: 12px 16px;
      background: var(--bg-tertiary, #1c2129);
      border-bottom: 1px solid var(--border, #30363d);
      font-size: 12px;
      color: var(--text-primary, #e6edf3);
    }
    .detail h4 {
      margin: 0 0 6px;
      font-size: 12px;
      color: var(--text-secondary, #8b949e);
      text-transform: uppercase;
    }
    .detail pre {
      margin: 0 0 12px;
      padding: 8px 10px;
      background: var(--bg-secondary, #161b22);
      border: 1px solid var(--border, #30363d);
      border-radius: 6px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
    }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      background: var(--bg-tertiary, #1c2129);
      color: var(--text-primary, #e6edf3);
    }
    .badge.error {
      background: rgba(248, 81, 73, 0.18);
      color: var(--red, #f85149);
    }
  `;

  @property({ attribute: false })
  gateway!: AppGateway;

  // Memories
  @state() private memories: readonly Memory[] = [];
  @state() private memoryFilter: '' | MemoryType = '';
  @state() private memoryError = '';
  @state() private memoryLoading = false;

  // Agent runs
  @state() private runs: readonly AgentRunSummary[] = [];
  @state() private runsError = '';
  @state() private runsLoading = false;
  @state() private expandedRunId: string | null = null;
  @state() private expandedRun: AgentRunFull | null = null;
  @state() private detailLoading = false;

  private memoryClient: MemoryClient | null = null;
  private agentRunsClient: AgentRunsClient | null = null;
  private loaded = false;

  override connectedCallback(): void {
    super.connectedCallback();
    if (this.gateway) {
      this.attach();
    }
  }

  override updated(): void {
    if (!this.memoryClient && this.gateway) {
      this.attach();
    }
  }

  private attach(): void {
    this.memoryClient = createMemoryClient(this.gateway);
    this.agentRunsClient = createAgentRunsClient(this.gateway);
    if (!this.loaded) {
      this.loaded = true;
      void this.loadMemories();
      void this.loadRuns();
    }
  }

  private async loadMemories(): Promise<void> {
    if (!this.memoryClient || !this.gateway?.isConnected) {
      return;
    }
    this.memoryLoading = true;
    this.memoryError = '';
    try {
      const params: Parameters<MemoryClient['list']>[0] = { limit: 100 };
      if (this.memoryFilter) {
        params.type = this.memoryFilter;
      }
      const res = await this.memoryClient.list(params);
      this.memories = res.memories;
    } catch (err) {
      this.memoryError = (err as Error).message;
    } finally {
      this.memoryLoading = false;
    }
  }

  private async loadRuns(): Promise<void> {
    if (!this.agentRunsClient || !this.gateway?.isConnected) {
      return;
    }
    this.runsLoading = true;
    this.runsError = '';
    try {
      const res = await this.agentRunsClient.list({ limit: 50 });
      this.runs = res.runs;
    } catch (err) {
      this.runsError = (err as Error).message;
    } finally {
      this.runsLoading = false;
    }
  }

  private onMemoryFilterChange(e: Event): void {
    this.memoryFilter = (e.target as HTMLSelectElement).value as '' | MemoryType;
    void this.loadMemories();
  }

  private async onMemoryDelete(memory: Memory): Promise<void> {
    if (!this.memoryClient) {
      return;
    }
    const preview = memory.content.length > 60 ? `${memory.content.slice(0, 60)}…` : memory.content;
    const confirmed = window.confirm(
      `다음 기억을 삭제하시겠습니까?\n\n[${memory.type}] ${preview}`,
    );
    if (!confirmed) {
      return;
    }
    this.memoryError = '';
    try {
      await this.memoryClient.delete(memory.id);
      await this.loadMemories();
    } catch (err) {
      this.memoryError = (err as Error).message;
    }
  }

  private async toggleRun(runId: string): Promise<void> {
    if (this.expandedRunId === runId) {
      this.expandedRunId = null;
      this.expandedRun = null;
      return;
    }
    this.expandedRunId = runId;
    this.expandedRun = null;
    if (!this.agentRunsClient) {
      return;
    }
    this.detailLoading = true;
    try {
      const res = await this.agentRunsClient.get(runId);
      if (this.expandedRunId === runId) {
        this.expandedRun = res.run;
      }
    } catch (err) {
      this.runsError = (err as Error).message;
    } finally {
      this.detailLoading = false;
    }
  }

  private renderMemoriesSection() {
    return html`
      <section>
        <div class="section-header">
          <h3>내 기억</h3>
          <div class="controls">
            <select .value=${this.memoryFilter} @change=${this.onMemoryFilterChange}>
              ${MEMORY_TYPES.map((t) => html`<option value=${t.value}>${t.label}</option>`)}
            </select>
            <button class="refresh" @click=${this.loadMemories} ?disabled=${this.memoryLoading}>
              ${this.memoryLoading ? '불러오는 중...' : '새로고침'}
            </button>
          </div>
        </div>
        ${this.memoryError ? html`<div class="error" role="alert">${this.memoryError}</div>` : ''}
        ${this.memories.length === 0
          ? html`<div class="empty">저장된 기억이 없습니다.</div>`
          : html`
              <table>
                <thead>
                  <tr>
                    <th>유형</th>
                    <th>내용</th>
                    <th>세션</th>
                    <th>생성일</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  ${this.memories.map(
                    (m) => html`
                      <tr>
                        <td><span class="badge">${m.type}</span></td>
                        <td class="content">${m.content}</td>
                        <td>${m.sessionKey}</td>
                        <td>${new Date(m.createdAt).toLocaleString()}</td>
                        <td>
                          <button class="danger" @click=${() => this.onMemoryDelete(m)}>
                            삭제
                          </button>
                        </td>
                      </tr>
                    `,
                  )}
                </tbody>
              </table>
            `}
      </section>
    `;
  }

  private renderRunDetail() {
    if (this.detailLoading) {
      return html`<div class="detail">불러오는 중...</div>`;
    }
    const run = this.expandedRun;
    if (!run) {
      return html`<div class="detail">상세 데이터 없음</div>`;
    }
    return html`
      <div class="detail">
        <h4>Prompt</h4>
        <pre>${run.prompt}</pre>
        <h4>Output</h4>
        <pre>${run.output}</pre>
        ${run.error
          ? html`<h4>Error</h4>
              <pre>${run.error}</pre>`
          : ''}
        ${run.toolCalls.length > 0
          ? html`<h4>Tool Calls (${run.toolCalls.length})</h4>
              <pre>${JSON.stringify(run.toolCalls, null, 2)}</pre>`
          : ''}
        <h4>Metadata</h4>
        <pre>
agentId: ${run.agentId}
model: ${run.modelUsed ?? '-'}
role: ${run.role ?? '-'}
duration: ${run.durationMs}ms
tokens: in=${run.tokensInput}, out=${run.tokensOutput}
memoryId: ${run.memoryId ?? '-'}
createdAt: ${new Date(run.createdAt).toLocaleString()}</pre
        >
      </div>
    `;
  }

  private renderRunsSection() {
    return html`
      <section>
        <div class="section-header">
          <h3>에이전트 실행 이력</h3>
          <div class="controls">
            <button class="refresh" @click=${this.loadRuns} ?disabled=${this.runsLoading}>
              ${this.runsLoading ? '불러오는 중...' : '새로고침'}
            </button>
          </div>
        </div>
        ${this.runsError ? html`<div class="error" role="alert">${this.runsError}</div>` : ''}
        ${this.runs.length === 0
          ? html`<div class="empty">실행 이력이 없습니다.</div>`
          : html`
              <table>
                <thead>
                  <tr>
                    <th>시각</th>
                    <th>Agent</th>
                    <th>Role</th>
                    <th>Model</th>
                    <th>Duration</th>
                    <th>Output (truncated)</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  ${this.runs.map((r) => {
                    const expanded = this.expandedRunId === r.id;
                    return html`
                      <tr
                        class="run-row ${expanded ? 'expanded' : ''}"
                        @click=${() => this.toggleRun(r.id)}
                      >
                        <td>${new Date(r.createdAt).toLocaleString()}</td>
                        <td>${r.agentId}</td>
                        <td>${r.role ?? '-'}</td>
                        <td>${r.modelUsed ?? '-'}</td>
                        <td class="numeric">${r.durationMs}ms</td>
                        <td class="content">${r.output}</td>
                        <td>
                          ${r.error
                            ? html`<span class="badge error">error</span>`
                            : html`<span class="badge">ok</span>`}
                        </td>
                      </tr>
                      ${expanded
                        ? html`<tr>
                            <td colspan="7" style="padding:0;">${this.renderRunDetail()}</td>
                          </tr>`
                        : ''}
                    `;
                  })}
                </tbody>
              </table>
            `}
      </section>
    `;
  }

  private renderRoutingSection() {
    return html`
      <section>
        <div class="section-header">
          <h3>라우팅 통계</h3>
        </div>
        <div class="placeholder">데이터 없음 (Phase 24+ 산출 가용 시 표시)</div>
      </section>
    `;
  }

  override render() {
    return html`
      <h2>Settings</h2>
      ${!this.gateway?.isConnected
        ? html`<div class="empty">게이트웨이 연결 대기 중...</div>`
        : html`
            ${this.renderMemoriesSection()} ${this.renderRunsSection()}
            ${this.renderRoutingSection()}
          `}
    `;
  }
}
