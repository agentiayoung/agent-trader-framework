#!/bin/bash
# Lance TradingView Desktop en mode CDP debug (port 9222) sur macOS / Linux.
# Usage : bash scripts/launch-tradingview-debug.sh
# Le MCP tradingview-desktop se connecte ensuite via Chrome DevTools Protocol.

PORT=9222

if command -v lsof >/dev/null 2>&1 && lsof -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "! Le port $PORT est deja en ecoute (TradingView deja lance en debug ?). Verifier avec tv_health_check."
  exit 0
fi

OS="$(uname -s)"
case "$OS" in
  Darwin)
    if [ -d "/Applications/TradingView.app" ]; then
      open -a TradingView --args --remote-debugging-port=$PORT
      echo "OK TradingView lance sur CDP port $PORT (macOS)"
    else
      echo "X TradingView.app introuvable dans /Applications. Installer : https://www.tradingview.com/desktop/"
      echo "  Ou utiliser le tool MCP 'tv_launch' (auto-detection)."
      exit 1
    fi
    ;;
  Linux)
    if command -v tradingview >/dev/null 2>&1; then
      tradingview --remote-debugging-port=$PORT &
      echo "OK TradingView lance sur CDP port $PORT (Linux)"
    elif [ -x "/opt/TradingView/tradingview" ]; then
      /opt/TradingView/tradingview --remote-debugging-port=$PORT &
      echo "OK TradingView lance sur CDP port $PORT (/opt/TradingView)"
    else
      echo "X TradingView introuvable (PATH ou /opt/TradingView). Installer : https://www.tradingview.com/desktop/"
      echo "  Ou utiliser le tool MCP 'tv_launch' (auto-detection)."
      exit 1
    fi
    ;;
  *)
    echo "X OS non supporte par ce script : $OS. Sous Windows utiliser scripts/launch-tradingview-debug.ps1"
    exit 1
    ;;
esac

echo "   Verifier la connexion : dans Claude Code, demander 'Use tv_health_check'."
