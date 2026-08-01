#!/usr/bin/env bash
set -euo pipefail

candidate_root=${STOCK_ONLY_CANDIDATE_ROOT:-$PWD}
historical_path=${STOCK_ONLY_HISTORICAL_PATH:-/Users/etanheyman/Gits/t3layer/test/p2-live-proof-runner.test.ts}
historical_sha=${STOCK_ONLY_HISTORICAL_SHA256:-0202d976418d6da8d21eb708025f8b1e378ed34b83daa5201cf1a9255a5691ee}

if [[ ! -d "$candidate_root" ]]; then
  echo "ERROR: candidate root is not a directory" >&2
  exit 2
fi
if [[ ! -f "$historical_path" ]]; then
  echo "ERROR: historical evidence file is missing" >&2
  exit 2
fi

private_scope='@t3tools'
private_name='runtime''-client'
private_needle="${private_scope}/${private_name}"
release_host='github.com/'
release_owner='Etan''Hey/t3code'
release_needle="${release_host}${release_owner}"
fork_marker='ORCHESTRATION_''WS_METHODS'
factory_marker='makeRpc''SessionFactory'

paths_file=$(mktemp "${TMPDIR:-/tmp}/t3layer-stock-paths.XXXXXX")
cleanup() {
  rm -f -- "$paths_file"
}
trap cleanup EXIT INT TERM

/usr/bin/git -C "$candidate_root" ls-files --cached --others --exclude-standard -z -- \
  package.json bun.lock src test README.md scripts docs >"$paths_file"

violation=0
while IFS= read -r -d '' relative_path; do
  candidate_path="$candidate_root/$relative_path"
  [[ -f "$candidate_path" ]] || continue
  for needle in "$private_needle" "$release_needle" "$fork_marker" "$factory_marker"; do
    if /usr/bin/grep -F -q -- "$needle" "$candidate_path"; then
      echo "ERROR: forbidden candidate reference in $relative_path" >&2
      violation=1
      break
    fi
  done
done <"$paths_file"

if [[ "$violation" -ne 0 ]]; then
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  actual_historical_sha=$(sha256sum "$historical_path" | /usr/bin/awk '{print $1}')
else
  actual_historical_sha=$(shasum -a 256 "$historical_path" | /usr/bin/awk '{print $1}')
fi
if [[ "$actual_historical_sha" != "$historical_sha" ]]; then
  echo "ERROR: historical evidence SHA-256 mismatch" >&2
  exit 1
fi

echo "STOCK_ONLY_CHECK: PASS"
echo "HISTORICAL_ALLOWLIST_SHA256: $actual_historical_sha"
