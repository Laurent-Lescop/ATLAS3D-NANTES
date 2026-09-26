#!/bin/sh
# Atlas 3D de Nantes (Linux) : lance le serveur local puis ouvre le navigateur.
DIR="$(cd "$(dirname "$0")" && pwd)"
case "$(uname -m)" in
  aarch64|arm64) BIN="$DIR/bin/atlas-linux-arm64" ;;
  *)             BIN="$DIR/bin/atlas-linux-amd64" ;;
esac
chmod +x "$BIN" 2>/dev/null
exec "$BIN" -racine "$DIR" "$@"
