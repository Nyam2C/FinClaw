// packages/web/src/views/alerts-view.ts

import { LitElement, html, css } from 'lit';
import { customElement } from 'lit/decorators.js';

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
    .placeholder {
      padding: 32px;
      text-align: center;
      color: var(--text-secondary, #8b949e);
      border: 1px dashed var(--border, #30363d);
      border-radius: 8px;
    }
  `;

  override render() {
    return html`
      <h2>Alerts</h2>
      <div class="placeholder">Active alerts and alert history will appear here.</div>
    `;
  }
}
