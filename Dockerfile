# Dockerfile (Phase 0 scaffold)

# ── Stage 1: Builder ──
FROM node:22-bookworm-slim AS builder

RUN corepack enable

WORKDIR /app

# 의존성 캐시 레이어 — 각 패키지 package.json을 개별 COPY
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/types/package.json ./packages/types/
COPY packages/config/package.json ./packages/config/
COPY packages/storage/package.json ./packages/storage/
COPY packages/agent/package.json ./packages/agent/
COPY packages/channel-discord/package.json ./packages/channel-discord/
COPY packages/skills-finance/package.json ./packages/skills-finance/
COPY packages/server/package.json ./packages/server/

RUN pnpm install --frozen-lockfile

# 소스 복사 및 빌드
COPY tsconfig.json tsconfig.base.json ./
COPY packages/ ./packages/

RUN pnpm build

# TODO (Phase 19): 웹 UI 빌드 추가
# RUN pnpm --filter @finclaw/server ui:build

# 프로덕션 의존성만 재설치
RUN pnpm install --frozen-lockfile --prod

# ── Stage 2: Runner ──
FROM node:22-bookworm-slim AS runner

RUN corepack enable

WORKDIR /app

# 보안: non-root 사용자
USER node

# builder에서 필요한 파일만 복사
COPY --from=builder --chown=node:node /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=builder --chown=node:node /app/node_modules/ ./node_modules/
COPY --from=builder --chown=node:node /app/packages/ ./packages/

# TODO (Phase 16-18): 스킬 파일 복사
# COPY --chown=node:node skills/ ./skills/

ENV NODE_ENV=production
ENV FINCLAW_HOST=0.0.0.0
ENV FINCLAW_PORT=3000

EXPOSE 3000

# TODO (Phase 11): /health 엔드포인트 구현 후 활성화
# HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
#   CMD node -e "fetch('http://localhost:3000/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "packages/server/dist/main.js"]
