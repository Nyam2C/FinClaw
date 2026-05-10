// packages/web/src/views/audit-view.ts
// Phase 30 C7: access_log 테이블 + 필터 + traceId 점프 (수동).

import type { AppGateway } from '../app-gateway.js';

interface AccessLogEntry {
  id?: number;
  ts: number;
  method: string;
  paramsHash: string;
  actor?: string;
  ip?: string;
  durationMs: number;
  status: string;
  error?: string;
  traceId?: string;
}

function escapeHtml(s: string): string {
  return s.replace(/[<>&"]/g, (c) =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : '&quot;',
  );
}

export function renderAuditView(root: HTMLElement, gateway: AppGateway): void {
  root.innerHTML = `
    <div style="padding:16px;color:var(--text-primary,#e6edf3);">
      <h2>Audit Log</h2>
      <div style="display:flex;gap:8px;margin-bottom:12px;">
        <input id="audit-method" placeholder="method (e.g. trace.get)" style="background:#0d1117;color:#e6edf3;border:1px solid #30363d;padding:4px 8px;" />
        <input id="audit-actor" placeholder="actor" style="background:#0d1117;color:#e6edf3;border:1px solid #30363d;padding:4px 8px;" />
        <input id="audit-status" placeholder="status" style="background:#0d1117;color:#e6edf3;border:1px solid #30363d;padding:4px 8px;" />
        <button id="audit-refresh" style="background:#238636;color:white;border:0;padding:4px 12px;cursor:pointer;">Refresh</button>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead>
          <tr style="text-align:left;border-bottom:1px solid #30363d;">
            <th>Time</th><th>Method</th><th>Actor</th><th>Duration</th><th>Status</th><th>Trace</th>
          </tr>
        </thead>
        <tbody id="audit-body"><tr><td colspan="6">loading...</td></tr></tbody>
      </table>
    </div>
  `;

  const body = root.querySelector('#audit-body') as HTMLElement;
  const methodEl = root.querySelector('#audit-method') as HTMLInputElement;
  const actorEl = root.querySelector('#audit-actor') as HTMLInputElement;
  const statusEl = root.querySelector('#audit-status') as HTMLInputElement;
  const refreshBtn = root.querySelector('#audit-refresh') as HTMLButtonElement;

  async function load(): Promise<void> {
    body.innerHTML = '<tr><td colspan="6">loading...</td></tr>';
    const params: Record<string, unknown> = { limit: 100 };
    if (methodEl.value) {
      params['method'] = methodEl.value;
    }
    if (actorEl.value) {
      params['actor'] = actorEl.value;
    }
    if (statusEl.value) {
      params['status'] = statusEl.value;
    }
    try {
      const rows = (await gateway.send('audit.list', params)) as AccessLogEntry[];
      if (!rows.length) {
        body.innerHTML = '<tr><td colspan="6">no entries</td></tr>';
        return;
      }
      body.innerHTML = rows
        .map((r) => {
          const time = new Date(r.ts).toISOString();
          const traceCell = r.traceId
            ? `<a href="#trace/${r.traceId}" style="color:#58a6ff;font-family:monospace;">${r.traceId.slice(0, 12)}...</a>`
            : '';
          return `<tr style="border-bottom:1px solid #21262d;">
            <td>${escapeHtml(time)}</td>
            <td>${escapeHtml(r.method)}</td>
            <td>${escapeHtml(r.actor ?? '')}</td>
            <td>${r.durationMs}ms</td>
            <td>${escapeHtml(r.status)}</td>
            <td>${traceCell}</td>
          </tr>`;
        })
        .join('');
    } catch (err) {
      body.innerHTML = `<tr><td colspan="6" style="color:#f85149">load failed: ${(err as Error).message}</td></tr>`;
    }
  }

  refreshBtn.addEventListener('click', () => {
    void load();
  });
  void load();
}
