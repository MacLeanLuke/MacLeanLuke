#!/usr/bin/env bash
#
# guard.sh — the thing standing between a careless `git commit -am "wip"` and a
# permanent public record of something that should not have left the building.
#
# Runs in two places, with the same rules in both:
#
#   .githooks/pre-commit   scans staged files, blocks the commit    (fast, local)
#   .github/workflows      scans the whole tree, blocks the merge   (authoritative)
#
# The local hook is the one that saves you; the CI run is the one that can not
# be skipped with --no-verify. Neither is sufficient alone.
#
# Usage:
#   scripts/guard.sh            scan staged files (hook mode)
#   scripts/guard.sh --ci       scan every tracked file (CI mode)
#   scripts/guard.sh --all      same as --ci, for running by hand
#
# Exit codes: 0 clean, 1 violations found, 2 misuse.

set -euo pipefail

MODE="staged"
case "${1:-}" in
  --ci | --all) MODE="all" ;;
  "") ;;
  *)
    printf 'guard: unknown argument %s\n' "$1" >&2
    exit 2
    ;;
esac

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# Colour only when attached to a terminal, so CI logs stay clean.
if [ -t 1 ]; then
  BOLD=$'\033[1m'; RED=$'\033[31m'; YEL=$'\033[33m'; GRN=$'\033[32m'; DIM=$'\033[2m'; OFF=$'\033[0m'
else
  BOLD=""; RED=""; YEL=""; GRN=""; DIM=""; OFF=""
fi

VIOLATIONS=0
report() {
  # report <file> <line-or-dash> <rule> <detail>
  VIOLATIONS=$((VIOLATIONS + 1))
  printf '%s%s%s:%s %s%s%s — %s\n' "$BOLD" "$1" "$OFF" "$2" "$RED" "$3" "$OFF" "$4"
}

# ==============================================================================
# What may live in this repo at all.
#
# Mirrors the allowlist in .gitignore. Kept as a second, independent check so a
# `git add -f` (which defeats .gitignore entirely) still gets caught.
# ==============================================================================
ALLOWED_PATHS='^(README\.md|LICENSE|\.gitignore|\.gitattributes|\.github/CODEOWNERS|\.github/[^/]+\.md|\.github/denylist\.example\.txt|\.github/workflows/[^/]+\.yml|\.githooks/pre-commit|scripts/[^/]+\.(sh|mjs)|assets/[^/]+\.(svg|png))$'

MAX_BYTES=$((2 * 1024 * 1024))

# ==============================================================================
# Credential shapes.
#
# These are patterns for things that are secret by construction — a private key
# block is never anything but a private key. GitHub's own push protection
# catches many of these too; this runs first, and catches them before the commit
# object exists rather than at push time.
# ==============================================================================
read -r -d '' SECRET_RULES <<'RULES' || true
private key block|-----BEGIN [A-Z ]*PRIVATE KEY-----
AWS access key id|AKIA[0-9A-Z]{16}
AWS secret access key|aws_secret_access_key[[:space:]]*[:=]
GitHub token|gh[pousr]_[A-Za-z0-9]{36,}
GitHub fine-grained token|github_pat_[A-Za-z0-9_]{40,}
Slack token|xox[baprs]-[A-Za-z0-9-]{10,}
Slack webhook|hooks\.slack\.com/services/[A-Za-z0-9/]{20,}
Google API key|AIza[0-9A-Za-z_-]{35}
Stripe live key|sk_live_[0-9a-zA-Z]{20,}
Anthropic API key|sk-ant-[A-Za-z0-9_-]{20,}
OpenAI API key|sk-proj-[A-Za-z0-9_-]{20,}
JSON Web Token|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+
bearer token|[Bb]earer[[:space:]]+[A-Za-z0-9._~+/-]{24,}
database URL with password|(postgres|postgresql|mysql|mongodb\+srv|mongodb|redis|amqp)://[^[:space:]:@/]+:[^[:space:]@/]+@
npm token|npm_[A-Za-z0-9]{36}
PyPI token|pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{20,}
hardcoded credential|(password|passwd|secret|api[_-]?key|access[_-]?token)[[:space:]]*[:=][[:space:]]*["'"'"'][^"'"'"']{8,}["'"'"']
internal hostname|[a-z0-9-]+\.(internal|corp|intranet|lan)\b
RULES

# ==============================================================================
# Terms you must not publish.
#
# Deliberately NOT in this repo. A committed denylist publishes the exact words
# it exists to suppress, which is a self-defeating design — the file becomes a
# public index of what is sensitive.
#
# Local : .githooks/denylist.local.txt   (gitignored, never committed)
# CI    : GUARD_DENYLIST repo secret     (newline-separated, masked in logs)
#
# Matching is fixed-string and case-insensitive, so entries are plain words —
# no regex escaping, no chance of a stray metacharacter silently disabling a rule.
# See .github/denylist.example.txt for what belongs in it.
# ==============================================================================
DENY_TERMS_FILE="$(mktemp)"
trap 'rm -f "$DENY_TERMS_FILE"' EXIT

if [ -f .githooks/denylist.local.txt ]; then
  grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' .githooks/denylist.local.txt >>"$DENY_TERMS_FILE" || true
fi
if [ -n "${GUARD_DENYLIST:-}" ]; then
  printf '%s\n' "$GUARD_DENYLIST" | grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' >>"$DENY_TERMS_FILE" || true
fi

DENY_COUNT=$(wc -l <"$DENY_TERMS_FILE" | tr -d ' ')

# ==============================================================================
# Gather the file list
# ==============================================================================
if [ "$MODE" = "staged" ]; then
  FILES=$(git diff --cached --name-only --diff-filter=ACMR)
else
  FILES=$(git ls-files)
fi

if [ -z "$FILES" ]; then
  printf '%sguard:%s nothing to scan\n' "$GRN" "$OFF"
  exit 0
fi

FILE_COUNT=$(printf '%s\n' "$FILES" | wc -l | tr -d ' ')

# ==============================================================================
# Scan
# ==============================================================================
while IFS= read -r file; do
  [ -z "$file" ] && continue
  [ -f "$file" ] || continue

  # --- 1. path allowlist ------------------------------------------------------
  if ! printf '%s' "$file" | grep -Eq "$ALLOWED_PATHS"; then
    report "$file" "-" "path not allowlisted" \
      "this repo only holds a README, its assets, and the guards. Widen .gitignore and ALLOWED_PATHS if this is intentional."
    continue
  fi

  # --- 2. size ----------------------------------------------------------------
  bytes=$(wc -c <"$file" | tr -d ' ')
  if [ "$bytes" -gt "$MAX_BYTES" ]; then
    report "$file" "-" "file too large" "$(printf '%s bytes, limit is %s' "$bytes" "$MAX_BYTES")"
  fi

  # --- 3. credential shapes ---------------------------------------------------
  # guard.sh holds the patterns themselves, so scanning it always self-matches.
  if [ "$file" != "scripts/guard.sh" ]; then
    while IFS='|' read -r label pattern; do
      [ -z "${label:-}" ] && continue
      hits=$(grep -InE "$pattern" "$file" 2>/dev/null | grep -v 'guard:allow' || true)
      if [ -n "$hits" ]; then
        while IFS= read -r hit; do
          [ -z "$hit" ] && continue
          report "$file" "${hit%%:*}" "$label" \
            "looks like a live credential. If it is a placeholder, append a 'guard:allow' comment on that line."
        done <<<"$hits"
      fi
    done <<<"$SECRET_RULES"
  fi

  # --- 4. denylisted terms ----------------------------------------------------
  # Never echo the matched term — that would print the secret into CI logs,
  # which are themselves public on a public repo. Report location only.
  if [ "$DENY_COUNT" -gt 0 ] && [ "$file" != ".github/denylist.example.txt" ]; then
    hits=$(grep -Inif "$DENY_TERMS_FILE" "$file" 2>/dev/null | cut -d: -f1 || true)
    if [ -n "$hits" ]; then
      while IFS= read -r lineno; do
        [ -z "$lineno" ] && continue
        report "$file" "$lineno" "denylisted term" \
          "matches an entry in your private denylist. Term withheld from this log on purpose."
      done <<<"$(printf '%s\n' "$hits" | sort -un)"
    fi
  fi
done <<<"$FILES"

# ==============================================================================
# Verdict
# ==============================================================================
printf '\n'
if [ "$DENY_COUNT" -eq 0 ]; then
  printf '%sguard:%s no denylist configured — term checking is OFF.\n' "$YEL" "$OFF"
  if [ "$MODE" = "staged" ]; then
    printf '       %scp .github/denylist.example.txt .githooks/denylist.local.txt%s and fill it in.\n' "$DIM" "$OFF"
  else
    printf '       %sSet the GUARD_DENYLIST repo secret to enable it in CI.%s\n' "$DIM" "$OFF"
  fi
fi

if [ "$VIOLATIONS" -gt 0 ]; then
  printf '%sguard: %s violation(s) across %s file(s) — blocked.%s\n' "$RED" "$VIOLATIONS" "$FILE_COUNT" "$OFF"
  exit 1
fi

printf '%sguard: %s file(s) clean%s (%s denylist term(s) active)\n' "$GRN" "$FILE_COUNT" "$OFF" "$DENY_COUNT"
