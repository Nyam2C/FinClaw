# FinClaw MCP Plugin

> stdio 기반 MCP (Model Context Protocol) 서버를 FinClaw plugin 으로 등록.
> 도구는 `ToolRegistry` 에 `group=mcp` 로 등록되며, 9-단계 정책의 require-approval 기본.

## manifest 예시

`~/.finclaw/plugins/my-mcp/manifest.json`:

```json
{
  "name": "my-mcp",
  "version": "0.1.0",
  "main": "index.js",
  "type": "tool",
  "mcpServers": [
    {
      "id": "fs",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "timeoutMs": 30000
    }
  ]
}
```

`index.js` 는 비워두거나 (`export const register = () => {};`) 일반 plugin API 를 사용해도 된다.

## 동작

1. 부팅 시 `loadPlugins` 가 `manifest.mcpServers` 를 발견 → stdio 프로세스 spawn.
2. `tools/list` 호출 → 각 도구를 `mcp:<spec.id>:<original_name>` 으로 namespace.
3. `ToolRegistry.register` 로 `group='mcp'`, `isExternal=true` (CircuitBreaker 적용).
4. 9-단계 정책: `mcp:*` pattern 의 `require-approval` rule 이 main.ts 에서 등록되어 호출 시 사용자 승인 요구.
5. 종료 시 `ProcessLifecycle` 가 누적된 `MCPClientHandle.shutdown()` 호출 → child stdio 정리.

## 환경 변수

- `FINCLAW_PLUGINS_DIR` — plugins 검색 경로 (default: `~/.finclaw/plugins`)
- 각 MCP 서버의 `env` 필드는 `process.env` 와 병합되어 child 에 전달.

## 알려진 제약

- transport: stdio 만. SSE/WebSocket 은 Phase 30+.
- FinClaw 자체를 MCP 서버로 노출하기는 비대상 (Phase 30+).
- 도구별 fine-grained 정책은 Phase 30 — 본 Phase 는 group 일괄 정책.

## 디버깅

- `plugins.loaded` 구조화 로그가 부팅 시 출력. `mcpServers: <count>` 필드로 활성화 수 확인.
- MCP 서버 spawn/연결 실패는 `recordDiagnostic` 으로 plugin diagnostics 슬롯에 누적 (severity=error).
