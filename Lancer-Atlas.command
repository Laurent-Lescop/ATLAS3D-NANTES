#!/bin/bash
# Atlas 3D de Nantes (macOS) : double-cliquez sur ce fichier.
# Au premier lancement, macOS peut bloquer le fichier : clic droit > Ouvrir.
cd "$(dirname "$0")" || exit 1
DIR="$(pwd)"
case "$(uname -m)" in
  arm64) BIN="$DIR/bin/atlas-macos-arm64" ;;
  *)     BIN="$DIR/bin/atlas-macos-amd64" ;;
esac
# Retire l'attribut de quarantaine posé par le téléchargement.
xattr -dr com.apple.quarantine "$DIR/bin" 2>/dev/null
chmod +x "$BIN" 2>/dev/null
exec "$BIN" -racine "$DIR"
