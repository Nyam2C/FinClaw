// packages/web/src/app.ts
// FinClawApp — central Lit element

import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { createAppChat, type AppChat, type ChatState } from './app-chat.js';
import { createAppGateway, type AppGateway } from './app-gateway.js';
import { renderMarkdown } from './markdown.js';

type ViewTab = 'chat' | 'market' | 'portfolio' | 'alerts' | 'settings';

@customElement('finclaw-app')
export class FinClawApp extends LitElement {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100vh;
      font-family: 'Inter', system-ui, sans-serif;
      background: var(--bg-primary, #0d1117);
      color: var(--text-primary, #e6edf3);
    }
    nav {
      display: flex;
      gap: 4px;
      padding: 8px 16px;
      background: var(--bg-secondary, #161b22);
      border-bottom: 1px solid var(--border, #30363d);
    }
    nav button {
      padding: 6px 16px;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: var(--text-secondary, #8b949e);
      cursor: pointer;
      font-size: 14px;
    }
    nav button[aria-selected='true'] {
      background: var(--accent, #1f6feb);
      color: #fff;
    }
    .status-bar {
      padding: 4px 16px;
      font-size: 12px;
      background: var(--bg-secondary, #161b22);
      border-top: 1px solid var(--border, #30363d);
      display: flex;
      gap: 12px;
    }
    .status-dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-right: 4px;
    }
    .status-dot.connected {
      background: var(--green, #3fb950);
    }
    .status-dot.disconnected {
      background: var(--red, #f85149);
    }
    main {
      flex: 1;
      overflow: auto;
      padding: 16px;
    }
    .chat-messages {
      max-width: 800px;
      margin: 0 auto;
    }
    .message {
      margin-bottom: 16px;
      padding: 12px;
      border-radius: 8px;
    }
    .message.user {
      background: var(--bg-tertiary, #1c2129);
    }
    .message.assistant {
      background: var(--bg-secondary, #161b22);
      border: 1px solid var(--border, #30363d);
    }
    .message-role {
      font-size: 12px;
      color: var(--text-secondary, #8b949e);
      margin-bottom: 4px;
    }
    .stream-buffer {
      opacity: 0.7;
      white-space: pre-wrap;
    }
    .chat-input {
      display: flex;
      gap: 8px;
      padding: 16px;
      max-width: 800px;
      margin: 0 auto;
      width: 100%;
      box-sizing: border-box;
    }
    .chat-input input {
      flex: 1;
      padding: 10px 14px;
      border: 1px solid var(--border, #30363d);
      border-radius: 8px;
      background: var(--bg-tertiary, #1c2129);
      color: var(--text-primary, #e6edf3);
      font-size: 14px;
      outline: none;
    }
    .chat-input input:focus {
      border-color: var(--accent, #1f6feb);
    }
    .chat-input button {
      padding: 10px 20px;
      border: none;
      border-radius: 8px;
      background: var(--accent, #1f6feb);
      color: #fff;
      cursor: pointer;
      font-size: 14px;
    }
    .chat-input button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .error-bar {
      padding: 8px 16px;
      background: var(--red-bg, #3d1114);
      color: var(--red, #f85149);
      font-size: 13px;
    }
  `;

  @state() private activeTab: ViewTab = 'chat';
  @state() private connected = false;
  @state() private chatState: ChatState = {
    messages: [],
    tools: [],
    status: 'idle',
    error: null,
    streamBuffer: '',
  };

  private gateway: AppGateway = createAppGateway();
  private chat: AppChat | null = null;
  private inputValue = '';

  override connectedCallback(): void {
    super.connectedCallback();
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') ?? '';
    const gatewayUrl =
      params.get('gateway') ?? `${window.location.protocol}//${window.location.host}`;
    const sessionId = params.get('session') ?? crypto.randomUUID();

    this.gateway.onConnected(() => {
      this.connected = true;
    });
    this.gateway.onDisconnected(() => {
      this.connected = false;
    });

    this.chat = createAppChat(this.gateway, sessionId);
    this.chat.onStateChange((s) => {
      this.chatState = s;
    });

    if (token) {
      this.gateway.connect(gatewayUrl, token);
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.chat?.dispose();
    this.gateway.disconnect();
  }

  private handleTabClick(tab: ViewTab): void {
    this.activeTab = tab;
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      this.handleSend();
    }
  }

  private handleInput(e: Event): void {
    this.inputValue = (e.target as HTMLInputElement).value;
  }

  private handleSend(): void {
    const text = this.inputValue.trim();
    if (!text || !this.chat || this.chatState.status === 'streaming') {
      return;
    }
    this.inputValue = '';
    const input = this.shadowRoot?.querySelector<HTMLInputElement>('.chat-input input');
    if (input) {
      input.value = '';
    }
    this.chat.sendMessage(text);
  }

  private renderChat() {
    return html`
      <div class="chat-messages">
        ${this.chatState.messages.map(
          (msg) => html`
            <div class="message ${msg.role}">
              <div class="message-role">${msg.role === 'user' ? 'You' : 'FinClaw'}</div>
              <div
                .innerHTML=${msg.role === 'assistant' ? renderMarkdown(msg.content) : msg.content}
              ></div>
            </div>
          `,
        )}
        ${this.chatState.streamBuffer
          ? html`
              <div class="message assistant">
                <div class="message-role">FinClaw</div>
                <div class="stream-buffer">${this.chatState.streamBuffer}</div>
              </div>
            `
          : ''}
      </div>
      <div class="chat-input">
        <input
          type="text"
          placeholder="Send a message..."
          @input=${this.handleInput}
          @keydown=${this.handleKeyDown}
          ?disabled=${!this.connected}
        />
        <button
          @click=${this.handleSend}
          ?disabled=${!this.connected || this.chatState.status === 'streaming'}
        >
          Send
        </button>
      </div>
    `;
  }

  override render() {
    const tabs: ViewTab[] = ['chat', 'market', 'portfolio', 'alerts', 'settings'];

    return html`
      <nav>
        ${tabs.map(
          (tab) => html`
            <button
              aria-selected=${this.activeTab === tab ? 'true' : 'false'}
              @click=${() => this.handleTabClick(tab)}
            >
              ${tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          `,
        )}
      </nav>

      ${this.chatState.error ? html`<div class="error-bar">${this.chatState.error}</div>` : ''}

      <main>
        ${this.activeTab === 'chat' ? this.renderChat() : ''}
        ${this.activeTab === 'market'
          ? html` <market-view .gateway=${this.gateway}></market-view> `
          : ''}
        ${this.activeTab === 'portfolio'
          ? html` <portfolio-view .gateway=${this.gateway}></portfolio-view> `
          : ''}
        ${this.activeTab === 'alerts'
          ? html` <alerts-view .gateway=${this.gateway}></alerts-view> `
          : ''}
        ${this.activeTab === 'settings' ? html` <settings-view></settings-view> ` : ''}
      </main>

      <div class="status-bar">
        <span>
          <span class="status-dot ${this.connected ? 'connected' : 'disconnected'}"></span>
          ${this.connected ? 'Connected' : 'Disconnected'}
        </span>
        <span>${this.chatState.status === 'streaming' ? 'Streaming...' : ''}</span>
      </div>
    `;
  }
}
