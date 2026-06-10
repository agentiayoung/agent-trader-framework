# Signal Executor — Agent Trader
# Build context = repo root (see docker-compose.yml). Polls the signals/ inbox
# written by the webhook and places bracket orders on the routed exchange
# (Bybit). NEVER place orders unless EXECUTOR_LIVE=1.
FROM node:20-slim

WORKDIR /app

# Skill the executor routes to — install its deps (node_modules excluded by
# .dockerignore, so npm populates them cleanly in the image).
COPY skills/bybit ./skills/bybit
RUN cd skills/bybit && npm install --omit=dev --no-audit --no-fund

COPY tradingview/executor ./tradingview/executor

ENV TV_SIGNALS_DIR=/signals
# DRY-RUN by default; set EXECUTOR_LIVE=1 (compose env / .env) to send real orders.
CMD ["node", "tradingview/executor/signal_executor.js", "--watch"]
