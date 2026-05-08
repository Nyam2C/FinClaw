// packages/web/src/views/trace-view.ts
// Phase 30 A11: trace 목록 + span tree (들여쓰기 텍스트 트리). flame graph 는 비대상.

import type { AppGateway } from '../app-gateway.js';

interface TraceListItem {
  trace_id: string;
  first_ns: number;
  last_ns: number | null;
  root_name: string;
}

interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: string;
  startNs: bigint | number;
  endNs?: bigint | number;
  attributes: Record<string, unknown>;
  events: unknown[];
  status: 'unset' | 'ok' | 'error';
  statusMessage?: string;
}

interface SpanTreeNode extends SpanRecord {
  children: readonly SpanTreeNode[];
}

interface TraceGetResult {
  traceId: string;
  spans: SpanRecord[];
  tree: SpanTreeNode[];
  agentRuns: unknown[];
}

interface TraceListResult {
  traces: TraceListItem[];
}

function nsToMs(ns: bigint | number): number {
  return Number(ns) / 1_000_000;
}

function durationMs(span: SpanRecord): string {
  if (span.endNs === undefined) {
    return '...';
  }
  const ms = nsToMs(span.endNs) - nsToMs(span.startNs);
  return `${ms.toFixed(1)}ms`;
}

function renderTreeNode(node: SpanTreeNode, depth: number): string {
  const indent = '  '.repeat(depth);
  const statusColor = node.status === 'error' ? '#f85149' : '#7ee787';
  const safeName = String(node.name).replace(/[<>&]/g, (c) =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;',
  );
  const line = `${indent}- <span style="color:${statusColor}">${safeName}</span> [${node.kind}] ${durationMs(node)}`;
  const children = node.children.map((c) => renderTreeNode(c, depth + 1)).join('\n');
  return children ? `${line}\n${children}` : line;
}

export function renderTraceView(root: HTMLElement, gateway: AppGateway): void {
  root.innerHTML = `
    <div style="display:flex;gap:16px;padding:16px;color:var(--text-primary,#e6edf3);">
      <div id="trace-list" style="flex:0 0 320px;border-right:1px solid #30363d;padding-right:12px;overflow-y:auto;max-height:600px;">
        <h3>Traces</h3>
        <div class="loading">loading...</div>
      </div>
      <div id="trace-detail" style="flex:1;overflow-y:auto;max-height:600px;">
        <div class="hint">select a trace</div>
      </div>
    </div>
  `;

  const listEl = root.querySelector('#trace-list') as HTMLElement;
  const detailEl = root.querySelector('#trace-detail') as HTMLElement;

  void (async () => {
    try {
      const result = (await gateway.send('trace.list', { limit: 50 })) as TraceListResult;
      if (!result.traces.length) {
        listEl.innerHTML = '<h3>Traces</h3><div>no traces yet</div>';
        return;
      }
      const items = result.traces
        .map((t) => {
          const dur =
            t.last_ns !== null ? `${(nsToMs(t.last_ns) - nsToMs(t.first_ns)).toFixed(0)}ms` : '...';
          return `<div class="trace-item" data-trace-id="${t.trace_id}" style="cursor:pointer;padding:6px 4px;border-bottom:1px solid #21262d;">
            <div style="font-family:monospace;font-size:11px;">${t.trace_id.slice(0, 16)}...</div>
            <div style="font-size:13px;">${t.root_name}</div>
            <div style="font-size:11px;color:#8b949e;">${dur}</div>
          </div>`;
        })
        .join('');
      listEl.innerHTML = `<h3>Traces</h3>${items}`;
      listEl.querySelectorAll('.trace-item').forEach((el) => {
        el.addEventListener('click', () => {
          const traceId = (el as HTMLElement).dataset.traceId;
          if (traceId) {
            void loadDetail(traceId);
          }
        });
      });
    } catch (err) {
      listEl.innerHTML = `<h3>Traces</h3><div style="color:#f85149">load failed: ${(err as Error).message}</div>`;
    }
  })();

  async function loadDetail(traceId: string): Promise<void> {
    detailEl.innerHTML = '<div>loading...</div>';
    try {
      const result = (await gateway.send('trace.get', { traceId })) as TraceGetResult;
      const treeText = result.tree.map((n) => renderTreeNode(n, 0)).join('\n');
      detailEl.innerHTML = `
        <h3 style="font-family:monospace;">${traceId}</h3>
        <pre style="background:#161b22;padding:12px;border-radius:4px;overflow:auto;font-size:12px;">${treeText}</pre>
        <h4>Agent Runs (${result.agentRuns.length})</h4>
        <pre style="background:#161b22;padding:12px;border-radius:4px;font-size:11px;">${JSON.stringify(result.agentRuns, null, 2)}</pre>
      `;
    } catch (err) {
      detailEl.innerHTML = `<div style="color:#f85149">load failed: ${(err as Error).message}</div>`;
    }
  }
}
