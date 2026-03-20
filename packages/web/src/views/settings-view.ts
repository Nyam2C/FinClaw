// packages/web/src/views/settings-view.ts

import { LitElement, html, css } from 'lit';
import { customElement } from 'lit/decorators.js';

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
      <h2>Settings</h2>
      <div class="placeholder">Configuration and preferences will appear here.</div>
    `;
  }
}
