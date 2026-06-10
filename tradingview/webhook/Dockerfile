# TradingView Webhook Listener — Agent Trader
# Build context = repo root (see docker-compose.yml). Webhook code is under
# tradingview/webhook/. (confluence_engine archivé le 09.06.2026 — l'import
# try/except du listener désactive proprement /webhook/confluence.)
FROM python:3.12-slim

WORKDIR /app

COPY tradingview/webhook/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY tradingview/webhook/webhook_listener.py .

ENV TV_SIGNALS_DIR=/signals
ENV TV_WEBHOOK_PORT=8080
ENV PYTHONPATH=/app
EXPOSE 8080

CMD ["uvicorn", "webhook_listener:app", "--host", "0.0.0.0", "--port", "8080"]
