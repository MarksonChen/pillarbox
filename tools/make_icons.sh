#!/bin/sh
# Regenerate icons/ from a square source image (macOS: uses sips).
# Usage: tools/make_icons.sh path/to/source.png
set -e
src="${1:?usage: tools/make_icons.sh source.png}"
dir="$(cd "$(dirname "$0")/.." && pwd)/icons"
mkdir -p "$dir"
for s in 16 32 48 128; do
  sips -z "$s" "$s" "$src" --out "$dir/icon$s.png" >/dev/null
done
echo "icons written to $dir"
