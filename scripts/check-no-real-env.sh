#!/usr/bin/env bash
# Security review 2026-06-13 (A5/A10) — pre-bundle secret hygiene check.
# Ported from the main AgenticZK repo (this clone-and-play repo lacked it).
#
# Fails if a REAL (regular file) `.env` / `*.env` / `.env.bak*` exists in the
# tree before a tar/zip is taken — guards against publishing a secret. Symlinks
# are accepted (tar packs them as symlinks → the tarball recipient sees a broken
# link, the secret content never enters the tar).
#
# The PRIMARY release filter is `.gitattributes` export-ignore (`git archive`
# auto-excludes .env/wallets/keys). This script is the backup defense for raw
# `tar -czf .` / `rsync` tools that ignore .gitattributes.
#
# Usage:
#   ./scripts/check-no-real-env.sh          # exit 0 if clean, 1 if a real .env exists
#   ./scripts/check-no-real-env.sh --strict # also fail on .env symlinks

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STRICT=0
[[ "${1:-}" == "--strict" ]] && STRICT=1

# Find every real .env / *.env / .env.bak* (EXCLUDING .env.example).
mapfile -t HITS < <(
  find "$ROOT" \
    -name "node_modules" -prune -o \
    -name ".git"         -prune -o \
    -name "dist"         -prune -o \
    -name "out"          -prune -o \
    -name "cache"        -prune -o \
    -type f \
    \( -name ".env" -o -name ".env.bak*" -o -name ".env.local" -o -name "*.env" -o -name "*.env.bak*" \) \
    ! -name ".env.example" \
    -print
)

mapfile -t SYMS < <(
  find "$ROOT" \
    -name "node_modules" -prune -o \
    -name ".git"         -prune -o \
    -type l \
    \( -name ".env" -o -name ".env.bak*" -o -name ".env.local" -o -name "*.env" \) \
    -print
)

FAIL=0
if [[ ${#HITS[@]} -gt 0 ]]; then
  echo "ERROR: real (regular-file) secret .env detected in the repo tree:" >&2
  printf '  %s\n' "${HITS[@]}" >&2
  echo "Move these out of the tree (e.g. an external secrets dir) + symlink them." >&2
  FAIL=1
fi

if [[ $STRICT -eq 1 && ${#SYMS[@]} -gt 0 ]]; then
  echo "STRICT: .env symlink(s) detected in the repo tree (--strict mode):" >&2
  printf '  %s\n' "${SYMS[@]}" >&2
  echo "Remove the symlinks before taking a tarball." >&2
  FAIL=1
fi

if [[ $FAIL -eq 1 ]]; then
  exit 1
fi

if [[ ${#SYMS[@]} -gt 0 ]]; then
  echo "OK (symlink-mode): no real .env in the tree, only symlinks:"
  for s in "${SYMS[@]}"; do echo "  $s -> $(readlink "$s")"; done
else
  echo "OK: repo tree clean, no .env."
fi
exit 0
