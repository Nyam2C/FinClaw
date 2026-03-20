// packages/web/src/views/market-view.ts

import { LitElement, html, css } from 'lit';
import { customElement } from 'lit/decorators.js';

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
      <h2>Market Overview</h2>
      <div class="placeholder">Real-time market data will appear here once connected to gateway.</div>
    `;
  }
}
