#!/usr/bin/env bash
# Compile le serveur local de l'atlas pour Windows, macOS et Linux (dossier bin/).
# Nécessite Go ≥ 1.22 : https://go.dev/dl/
set -euo pipefail
cd "$(dirname "$0")/../server"
mkdir -p ../bin

cibles=(
  "windows amd64 atlas-windows-amd64.exe"
  "darwin  arm64 atlas-macos-arm64"
  "darwin  amd64 atlas-macos-amd64"
  "linux   amd64 atlas-linux-amd64"
  "linux   arm64 atlas-linux-arm64"
)

for c in "${cibles[@]}"; do
  read -r os arch nom <<<"$c"
  echo "Compilation $nom"
  CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -trimpath -ldflags="-s -w" -o "../bin/$nom" .
done
chmod +x ../bin/atlas-macos-* ../bin/atlas-linux-*
ls -lh ../bin
