#!/usr/bin/env bash
# Verifies that `pnpm pack` for server / skills-finance produces tarballs
# containing prompts/*.md. Catches silent breakage of package.json#files.
set -euo pipefail

OUT=$(mktemp -d)
trap "rm -rf $OUT" EXIT

ROOT=$(pwd)
for pkg in server skills-finance; do
  echo "=== $pkg ==="
  (cd "$ROOT/packages/$pkg" && pnpm pack --pack-destination "$OUT" >/dev/null)
  TGZ=$(ls "$OUT"/finclaw-$pkg-*.tgz 2>/dev/null | head -1)
  if [ -z "$TGZ" ]; then
    echo "  FAIL: tarball not produced"
    exit 1
  fi
  COUNT=$(tar tzf "$TGZ" | grep -c 'prompts/.*\.md$' || true)
  if [ "$COUNT" -eq 0 ]; then
    echo "  FAIL: tarball missing prompts/*.md"
    tar tzf "$TGZ" | head -20
    exit 1
  fi
  echo "  OK: $COUNT .md files in tarball"
done

echo "all packages OK"
