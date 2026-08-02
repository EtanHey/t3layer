#!/usr/bin/env bash
set -euo pipefail

T3_STOCK_SHA=d3037064e61a9f059eafbd4f9869679779bd2a7c
stock_repo=/Users/etanheyman/Gits/t3code
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
implementation_repo=$(cd "$script_dir/.." && pwd -P)
candidate_repo=${T3_STOCK_CANDIDATE_REPO:-}
expected_candidate_sha=${T3_STOCK_CANDIDATE_SHA:-}
proof_target=${T3_STOCK_PROOF_TARGET:-/Users/etanheyman/Gits/t3layer/docs.local/audits/t3layer-stock-t3-realignment/phase-3-stock-live-proof.json}
trace_target=${T3_STOCK_TRACE_PATH:-}
trace_parent_canonical=''
trace_name=''
trace_enabled=false
trace_fd_open=false
proof_root=''
stock_tree=''
server_pid=''
server_birth=''
cleanup_root_valid=false
pid_stopped=false
worktree_removed=false
root_removed=false
proof_ready=false
provisional_json=''
candidate_sha=''
artifact_digest=''
actual_stock_sha=''
run_id=''
finalizer_source=''
test_mode=${T3_STOCK_HARNESS_TEST_MODE:-0}
provider_secret_ref=${T3_STOCK_PROVIDER_SECRET_REF:-}
provider_auth_mode=''
claude_executable=''
claude_version=''
provider_auth_expectation=''
clean_server_env=(/usr/bin/env -i "HOME=$HOME" "PATH=$PATH")
for preserved_name in USER LOGNAME LANG LC_ALL SHELL TMPDIR; do
  if [[ -n ${!preserved_name:-} ]]; then
    clean_server_env+=("$preserved_name=${!preserved_name}")
  fi
done

sha256_file() {
  local path=$1
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$path" | /usr/bin/awk '{print $1}'
  else
    shasum -a 256 "$path" | /usr/bin/awk '{print $1}'
  fi
}

sha256_stream() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | /usr/bin/awk '{print $1}'
  else
    shasum -a 256 | /usr/bin/awk '{print $1}'
  fi
}

file_mode() {
  local path=$1
  local mode
  if mode=$(/usr/bin/stat -c '%a' "$path" 2>/dev/null); then
    printf '%s\n' "$mode"
  else
    /usr/bin/stat -f '%Lp' "$path"
  fi
}

file_owner() {
  local path=$1
  local owner
  if owner=$(/usr/bin/stat -c '%u' "$path" 2>/dev/null); then
    printf '%s\n' "$owner"
  else
    /usr/bin/stat -f '%u' "$path"
  fi
}

run_finalizer() {
  printf '%s' "$finalizer_source" | bun run - "$@"
}

authenticated_curl() {
  printf 'Authorization: Bearer %s\n' "$http_token" | /usr/bin/curl --header @- "$@"
}

run_stage_seam() {
  stage=$1
  if [[ "$test_mode" == 1 ]]; then
    : "${T3_STOCK_HARNESS_COMMAND_RUNNER:?required in test mode}"
    "$T3_STOCK_HARNESS_COMMAND_RUNNER" "$stage" "$proof_root"
  fi
  fail_at "$stage"
}

validate_projection_trace_input() {
  if [[ -z "$trace_target" ]]; then
    if [[ "$test_mode" != 1 ]]; then
      preflight_error projection_trace_invalid missing_path
    fi
    return
  fi
  if [[ "$trace_target" != /* ]]; then
    preflight_error projection_trace_invalid path_not_absolute
  fi
  local trace_parent
  local proof_parent
  local proof_name
  local canonical_proof_parent
  local canonical_proof_target
  trace_parent=$(dirname -- "$trace_target")
  trace_name=$(basename -- "$trace_target")
  if [[ -z "$trace_name" || "$trace_name" == . || "$trace_name" == .. ]] ||
     ! trace_parent_canonical=$(cd "$trace_parent" 2>/dev/null && pwd -P); then
    preflight_error projection_trace_invalid parent_unavailable
  fi
  trace_target="$trace_parent_canonical/$trace_name"
  proof_parent=$(dirname -- "$proof_target")
  proof_name=$(basename -- "$proof_target")
  canonical_proof_target=$proof_target
  if canonical_proof_parent=$(cd "$proof_parent" 2>/dev/null && pwd -P); then
    canonical_proof_target="$canonical_proof_parent/$proof_name"
  fi
  if [[ "$trace_target" == "$canonical_proof_target" ]]; then
    preflight_error projection_trace_invalid path_conflicts_with_proof_target
  fi
  case "$trace_target" in
    "$proof_root"|"$proof_root"/*)
      preflight_error projection_trace_invalid path_inside_proof_root
      ;;
  esac
  trace_enabled=true
}

prepare_projection_trace() {
  if [[ "$trace_enabled" != true ]]; then
    return
  fi
  local previous_directory
  local opened_trace_parent
  local trace_parent_mode
  local trace_parent_owner
  local current_uid
  local relative_trace_target="./$trace_name"
  local trace_error=''
  previous_directory=$(pwd -P)
  if ! cd "$trace_parent_canonical"; then
    preflight_error projection_trace_invalid parent_unavailable
  fi
  opened_trace_parent=$(pwd -P 2>/dev/null || true)
  if [[ "$opened_trace_parent" != "$trace_parent_canonical" ]] ||
     ! trace_parent_mode=$(file_mode .) ||
     ! trace_parent_owner=$(file_owner .) ||
     ! current_uid=$(/usr/bin/id -u) ||
     [[ ! "$trace_parent_mode" =~ ^[0-7]{3,4}$ ||
        ! "$trace_parent_owner" =~ ^[0-9]+$ ||
        "$trace_parent_owner" != "$current_uid" ]]; then
    trace_error=insecure_parent
  elif (( (8#$trace_parent_mode & 0022) != 0 )); then
    trace_error=insecure_parent
  fi
  if [[ -n "$trace_error" ]]; then
    cd "$previous_directory" 2>/dev/null || true
    preflight_error projection_trace_invalid "$trace_error"
  fi

  run_stage_seam after-trace-parent-validation
  opened_trace_parent=$(pwd -P 2>/dev/null || true)
  if [[ "$opened_trace_parent" != "$trace_parent_canonical" ]]; then
    trace_error=parent_identity_changed
  elif [[ -e "$relative_trace_target" || -L "$relative_trace_target" ]]; then
    trace_error=path_already_exists
  elif ! (umask 077; set -o noclobber; : > "$relative_trace_target") 2>/dev/null; then
    trace_error=create_failed
  elif ! chmod 600 "$relative_trace_target" ||
       [[ ! -f "$relative_trace_target" || -L "$relative_trace_target" ]] ||
       [[ $(file_mode "$relative_trace_target") != 600 ]]; then
    trace_error=mode_or_type_mismatch
  elif ! exec 9>>"$relative_trace_target"; then
    trace_error=descriptor_open_failed
  else
    trace_fd_open=true
  fi
  if ! cd "$previous_directory"; then
    if [[ "$trace_fd_open" == true ]]; then exec 9>&-; trace_fd_open=false; fi
    preflight_error projection_trace_invalid restore_directory_failed
  fi
  if [[ -n "$trace_error" ]]; then
    if [[ "$trace_fd_open" == true ]]; then exec 9>&-; trace_fd_open=false; fi
    preflight_error projection_trace_invalid "$trace_error"
  fi
  export T3_STOCK_TRACE_PATH="$trace_target"
  export T3_STOCK_TRACE_FD=9
  run_stage_seam after-trace-open
}

preflight_error() {
  local code=$1
  local reason=$2
  printf 'ERROR: %s reason=%s\n' "$code" "$reason" >&2
  exit 2
}

validate_candidate_identity() {
  if [[ -z "$candidate_repo" || -z "$expected_candidate_sha" || ! "$expected_candidate_sha" =~ ^[0-9a-f]{40}$ || ! -d "$candidate_repo" ]]; then
    preflight_error candidate_identity_invalid missing_or_malformed_input
  fi
  if ! candidate_repo=$(cd "$candidate_repo" 2>/dev/null && pwd -P); then
    preflight_error candidate_identity_invalid unreadable_repository
  fi
  local head_sha
  local main_sha
  local origin_main_sha
  if ! head_sha=$(/usr/bin/git -C "$candidate_repo" rev-parse --verify HEAD 2>/dev/null); then
    preflight_error candidate_identity_invalid unreadable_head
  fi
  if [[ "$head_sha" != "$expected_candidate_sha" ]]; then
    preflight_error candidate_identity_mismatch expected_sha_does_not_match_head
  fi
  if ! main_sha=$(/usr/bin/git -C "$candidate_repo" rev-parse --verify refs/heads/main 2>/dev/null) ||
     ! origin_main_sha=$(/usr/bin/git -C "$candidate_repo" rev-parse --verify refs/remotes/origin/main 2>/dev/null); then
    preflight_error candidate_identity_unmerged head_not_main_and_origin_main
  fi
  if ! [[ "$head_sha" == "$main_sha" && "$head_sha" == "$origin_main_sha" ]]; then
    preflight_error candidate_identity_unmerged head_not_main_and_origin_main
  fi
  candidate_sha=$expected_candidate_sha
}

run_claude_probe() {
  "${clean_server_env[@]}" node -e '
const { spawnSync } = require("node:child_process");
const [executable, ...args] = process.argv.slice(1);
const result = spawnSync(executable, args, {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 5_000,
  maxBuffer: 1_048_576,
  killSignal: "SIGKILL",
});
if (result.error) process.exit(result.error.code === "ETIMEDOUT" ? 124 : 125);
if (result.status !== 0) process.exit(125);
process.stdout.write(result.stdout);
' "$@"
}

preflight_provider_auth() {
  if [[ -n "$provider_secret_ref" ]]; then
    provider_auth_mode=secret_ref
    provider_auth_expectation='{"mode":"secret_ref"}'
    return
  fi
  provider_auth_mode=subscription
  local resolved_claude
  resolved_claude=$(command -v claude 2>/dev/null || true)
  if [[ -z "$resolved_claude" || ! -x "$resolved_claude" ]]; then
    preflight_error provider_auth_unavailable claude_executable_not_found
  fi
  claude_executable=$resolved_claude
  if [[ -n ${T3_STOCK_CLAUDE_EXECUTABLE:-} ]]; then
    if [[ "$T3_STOCK_CLAUDE_EXECUTABLE" != "$claude_executable" ]]; then
      preflight_error provider_auth_unavailable claude_executable_mismatch
    fi
  fi

  local auth_status
  local probe_status
  set +e
  auth_status=$(run_claude_probe "$claude_executable" auth status)
  probe_status=$?
  set -e
  if [[ "$probe_status" -eq 124 ]]; then
    preflight_error provider_auth_unavailable auth_probe_timeout
  fi
  if [[ "$probe_status" -ne 0 ]]; then
    preflight_error provider_auth_unavailable auth_probe_failed
  fi
  if ! /usr/bin/jq -e 'type == "object" and (.loggedIn | type == "boolean") and (.authMethod | type == "string")' <<<"$auth_status" >/dev/null 2>&1; then
    preflight_error provider_auth_unavailable auth_probe_invalid
  fi
  if [[ $(/usr/bin/jq -r '.loggedIn' <<<"$auth_status") != true ]]; then
    preflight_error provider_auth_unavailable subscription_not_authenticated
  fi
  local normalized_auth_method
  normalized_auth_method=$(/usr/bin/jq -r '.authMethod | ascii_downcase | gsub("[^a-z]"; "")' <<<"$auth_status")
  case "$normalized_auth_method" in
    claudeai|subscription)
      ;;
    apikey|anthropicapikey|anthropicauthtoken)
      preflight_error provider_auth_unavailable subscription_auth_method_api_key
      ;;
    *)
      preflight_error provider_auth_unavailable subscription_auth_method_unrecognized
      ;;
  esac
  unset auth_status

  set +e
  claude_version=$(run_claude_probe "$claude_executable" --version)
  probe_status=$?
  set -e
  if [[ "$probe_status" -eq 124 ]]; then
    preflight_error provider_auth_unavailable auth_probe_timeout
  fi
  if [[ "$probe_status" -ne 0 || -z "$claude_version" || "$claude_version" == *$'\n'* || ${#claude_version} -gt 128 || ! "$claude_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]]; then
    preflight_error provider_auth_unavailable auth_probe_invalid
  fi
  provider_auth_expectation=$(/usr/bin/jq -cn \
    --arg claudeExecutable "$claude_executable" \
    --arg claudeVersion "$claude_version" \
    '{mode:"subscription",claudeExecutable:$claudeExecutable,claudeVersion:$claudeVersion}')
}

fail_at() {
  if [[ ${T3_STOCK_FAIL_AT:-} == "$1" ]]; then
    echo "ERROR: injected failure: $1" >&2
    exit 91
  fi
}

cleanup() {
  cleanup_status=$?
  set +e
  if [[ "$trace_fd_open" == true ]]; then
    exec 9>&-
    trace_fd_open=false
  fi
  if [[ -n "$server_pid" && -n "$server_birth" && "$server_pid" =~ ^[0-9]+$ ]]; then
    current_birth=$(/bin/ps -o lstart= -p "$server_pid" 2>/dev/null | /usr/bin/xargs)
    current_cwd=$(/usr/sbin/lsof -a -p "$server_pid" -d cwd -Fn 2>/dev/null | /usr/bin/sed -n 's/^n//p')
    if [[ -n "$current_birth" && "$current_birth" == "$server_birth" && "$current_cwd" == "$workspace" ]]; then
      /bin/kill -TERM "$server_pid" 2>/dev/null
      for _stop_attempt in {1..20}; do
        if ! /bin/kill -0 "$server_pid" 2>/dev/null; then break; fi
        sleep 0.1
      done
      if /bin/kill -0 "$server_pid" 2>/dev/null; then
        /bin/kill -KILL "$server_pid" 2>/dev/null
      fi
      wait "$server_pid" 2>/dev/null
      if ! /bin/kill -0 "$server_pid" 2>/dev/null; then pid_stopped=true; fi
    fi
  else
    pid_stopped=true
  fi
  if [[ -n "$stock_tree" ]]; then
    registered_paths=$(/usr/bin/git -C "$stock_repo" worktree list --porcelain 2>/dev/null)
    if /usr/bin/grep -F -x -q -- "worktree $stock_tree" <<<"$registered_paths"; then
      /usr/bin/git -C "$stock_repo" worktree remove --force "$stock_tree" >/dev/null 2>&1
    fi
    registered_after=$(/usr/bin/git -C "$stock_repo" worktree list --porcelain 2>/dev/null)
    if ! /usr/bin/grep -F -x -q -- "worktree $stock_tree" <<<"$registered_after"; then
      worktree_removed=true
    fi
  elif [[ -z "$stock_tree" || ! -e "$stock_tree" ]]; then
    worktree_removed=true
  fi
  if [[ ${T3_STOCK_FAIL_TEARDOWN_AT:-} != root && "$cleanup_root_valid" == true && -n "$proof_root" && "$proof_root" != / && "$proof_root" != "$HOME" && ! -L "$proof_root" ]]; then
    rm -rf -- "$proof_root"
    if [[ ! -e "$proof_root" ]]; then root_removed=true; fi
  fi
  if [[ "$cleanup_status" -eq 0 && ("$pid_stopped" != true || "$worktree_removed" != true || "$root_removed" != true) ]]; then
    cleanup_status=2
  fi
  if [[ "$cleanup_status" -eq 0 && "$proof_ready" == true && "$pid_stopped" == true && "$worktree_removed" == true && "$root_removed" == true ]]; then
    proof_dir=$(dirname "$proof_target")
    mkdir -p -- "$proof_dir"
    final_body_staging=$(mktemp "$proof_dir/.phase-3-stock-live-proof-body.XXXXXX")
    final_staging=$(mktemp "$proof_dir/.phase-3-stock-live-proof.XXXXXX")
    chmod 600 "$final_body_staging" "$final_staging"
    final_body=$(/usr/bin/jq -cS -n \
      --arg runId "$run_id" \
      --arg candidateSha "$candidate_sha" \
      --arg stockSha "$actual_stock_sha" \
      --arg artifactDigest "$artifact_digest" \
      --arg providerAuthMode "$provider_auth_mode" \
      --arg claudeExecutable "$claude_executable" \
      --arg claudeVersion "$claude_version" \
      --argjson live "$provisional_json" \
      --argjson negativeShellStatus "$negative_shell_status" \
      --argjson negativeDetailStatus "$negative_detail_status" \
      '{runId:$runId,candidateSha:$candidateSha,stockSha:$stockSha,success:true,cleanBeforeBuild:true,artifactDigest:$artifactDigest,privateResolution:false,provenance:{stockInstall:{command:"corepack pnpm install --frozen-lockfile",status:0},stockBuild:{command:"corepack pnpm --filter t3 build:bundle",status:0},candidateInstall:{command:"bun install --frozen-lockfile",status:0},exactCharacterization:{command:"corepack pnpm --filter t3 exec vp test run src/orchestration/Layers/T3LayerStockProjectionCharacterization.generated.test.ts",status:0},providerAuth:(if $providerAuthMode == "subscription" then {mode:"subscription",claudeExecutable:$claudeExecutable,claudeVersion:$claudeVersion} else {mode:"secret_ref"} end),isolatedBasenames:["stock-tree","t3layer-clean","server-home","workspace"]},exactHttpNegative:{status:500,shellStatus:$negativeShellStatus,detailStatus:$negativeDetailStatus,code:"internal_error",reason:"orchestration_dispatch_failed",threadAbsent:true},live:($live|del(.provisional,.success,.runId)),teardown:{pidStopped:true,worktreeRemoved:true,rootRemoved:true}}')
    printf '%s\n' "$final_body" >"$final_body_staging"
    if [[ ${T3_STOCK_FAIL_AT:-} == before-final-body-validation ]]; then
      rm -f -- "$final_body_staging" "$final_staging"
      echo "ERROR: injected failure: before-final-body-validation" >&2
      exit 91
    fi
    if ! run_finalizer publish "$final_body_staging" "$final_staging" "$run_id" "$candidate_sha" "$provider_auth_expectation"; then
      rm -f -- "$final_body_staging" "$final_staging"
      exit 2
    fi
    if [[ ${T3_STOCK_FAIL_AT:-} == after-final-body-validation ]]; then
      rm -f -- "$final_body_staging" "$final_staging"
      echo "ERROR: injected failure: after-final-body-validation" >&2
      exit 91
    fi
    if [[ $(file_mode "$final_staging") != 600 ]]; then
      rm -f -- "$final_body_staging" "$final_staging"
      cleanup_status=2
    fi
    if [[ "$cleanup_status" -ne 0 ]]; then
      echo "ERROR: final proof staging mode mismatch" >&2
      echo "cleanup root_removed=$root_removed worktree_removed=$worktree_removed pid_stopped=$pid_stopped" >&2
      exit "$cleanup_status"
    fi
    staging_bytes=$(sha256_file "$final_staging")
    if ! node -e 'const fs=require("node:fs");const [source,target]=process.argv.slice(1);const fd=fs.openSync(source,"r+");fs.fsyncSync(fd);fs.closeSync(fd);fs.renameSync(source,target);const check=fs.openSync(target,"r");fs.fsyncSync(check);fs.closeSync(check)' "$final_staging" "$proof_target"; then
      rm -f -- "$final_body_staging" "$final_staging"
      exit 2
    fi
    rm -f -- "$final_body_staging"
    if [[ ${T3_STOCK_FAIL_AT:-} == after-final-rename ]]; then
      rm -f -- "$proof_target"
      echo "ERROR: injected failure: after-final-rename" >&2
      exit 91
    fi
    chmod 600 "$proof_target"
    final_bytes=$(sha256_file "$proof_target")
    if [[ $(file_mode "$proof_target") != 600 || "$final_bytes" != "$staging_bytes" ]] || ! run_finalizer validate-envelope "$proof_target" "$run_id" "$candidate_sha" "$provider_auth_expectation"; then
      rm -f -- "$proof_target"
      echo "ERROR: final proof bytes, mode, checksum, identity, or teardown mismatch" >&2
      exit 2
    fi
  fi
  echo "cleanup root_removed=$root_removed worktree_removed=$worktree_removed pid_stopped=$pid_stopped" >&2
  exit "$cleanup_status"
}

validate_candidate_identity
preflight_provider_auth
proof_root=$(mktemp -d "${TMPDIR:-/tmp}/t3layer-stock-proof.XXXXXX")
trap cleanup EXIT INT TERM

canonical_root=$(cd "$proof_root" && pwd -P)
canonical_temp_base=$(cd "${TMPDIR:-/tmp}" && pwd -P)
expected_prefix="$canonical_temp_base/t3layer-stock-proof."
case "$canonical_root" in
  "$expected_prefix"*) ;;
  *) echo "ERROR: invalid proof root" >&2; exit 2 ;;
esac
if [[ -L "$proof_root" || "$canonical_root" == / || "$canonical_root" == "$HOME" ]]; then
  echo "ERROR: unsafe proof root" >&2
  exit 2
fi
proof_root=$canonical_root
cleanup_root_valid=true
validate_projection_trace_input
run_id=$(/usr/bin/uuidgen | /usr/bin/tr '[:upper:]' '[:lower:]')
stock_tree="$proof_root/stock-tree"
t3layer_clean="$proof_root/t3layer-clean"
server_home="$proof_root/server-home"
workspace="$proof_root/workspace"
server_log="$proof_root/server.log"
provisional="$proof_root/provisional.json"
mkdir -p -- "$t3layer_clean" "$server_home" "$workspace"
: >"$server_log"
: >"$provisional"
chmod 600 "$server_log" "$provisional"

run_stage_seam after-proof-root
if [[ "$test_mode" == 1 ]]; then
  stock_tree=''
  actual_stock_sha=$T3_STOCK_SHA
else
  /usr/bin/git -C "$stock_repo" worktree add --detach "$stock_tree" "$T3_STOCK_SHA"
fi
run_stage_seam after-worktree-add
if [[ "$test_mode" != 1 ]]; then
  actual_stock_sha=$(/usr/bin/git -C "$stock_tree" rev-parse HEAD)
  [[ "$actual_stock_sha" == "$T3_STOCK_SHA" ]]
  [[ -z $(/usr/bin/git -C "$stock_tree" status --short) ]]
  (cd "$stock_tree" && corepack pnpm install --frozen-lockfile)
fi
run_stage_seam after-stock-install
if [[ "$test_mode" != 1 ]]; then
  (cd "$stock_tree" && corepack pnpm --filter t3 build:bundle)
fi
run_stage_seam after-stock-build
if [[ "$test_mode" == 1 ]]; then
  artifact_digest=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
  mkdir -p -- "$t3layer_clean/scripts" "$t3layer_clean/src"
  /bin/cp "$implementation_repo/scripts/stock-proof-cli.ts" "$t3layer_clean/scripts/stock-proof-cli.ts"
  /bin/cp "$implementation_repo/src/stockProof.ts" "$t3layer_clean/src/stockProof.ts"
else
  /usr/bin/git -C "$candidate_repo" archive "$candidate_sha" | /usr/bin/tar -x -C "$t3layer_clean"
  artifact_digest=$(/usr/bin/git -C "$candidate_repo" archive "$candidate_sha" | sha256_stream)
fi
run_stage_seam after-archive-extract
if [[ "$test_mode" != 1 ]]; then
  (cd "$t3layer_clean" && bun install --frozen-lockfile)
fi
run_stage_seam after-candidate-install
finalizer_bundle="$proof_root/stock-proof-finalizer.mjs"
(cd "$t3layer_clean" && bun build scripts/stock-proof-cli.ts --target=bun --format=esm --outfile "$finalizer_bundle" >/dev/null)
finalizer_source=$(<"$finalizer_bundle")
if [[ -z "$finalizer_source" ]]; then
  echo "ERROR: empty stock proof finalizer bundle" >&2
  exit 2
fi

legacy_scope='@t3tools'
legacy_name='runtime''-client'
if [[ "$test_mode" != 1 ]] && (cd "$t3layer_clean" && bun -e "await import('${legacy_scope}/${legacy_name}')" >/dev/null 2>&1); then
  echo "ERROR: archived candidate resolves retired package" >&2
  exit 2
fi

exact_failure=''
if [[ ${T3_STOCK_FAIL_AT:-} == after-generated-fixture ]]; then
  exact_failure=after-generated-fixture
fi
if [[ "$test_mode" != 1 ]]; then
  T3_STOCK_EXACT_FAIL_AT="$exact_failure" bash "$t3layer_clean/scripts/stock-t3-exact-characterization.sh" "$stock_tree"
fi
run_stage_seam after-exact-characterization
if [[ "$test_mode" == 1 ]]; then
  http_token=test-mode-redacted
else
  http_token=$(node "$stock_tree/apps/server/dist/bin.mjs" auth session issue --base-dir "$server_home" --ttl 30m --label t3layer-stock-proof --subject t3layer-stock-proof --token-only)
fi
run_stage_seam after-bearer-issue
if [[ "$test_mode" != 1 ]] && /usr/sbin/lsof -nP -iTCP:3774 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "ERROR: port 3774 already bound" >&2
  exit 2
fi
set +x
provider_key=''
if [[ "$provider_auth_mode" == secret_ref ]]; then
  if [[ "$test_mode" == 1 ]]; then
    provider_key=test-mode-redacted
  else
    provider_key=$(op read "$provider_secret_ref")
  fi
fi
run_stage_seam after-secret-read
if [[ "$test_mode" == 1 ]]; then
  if [[ -n ${T3_STOCK_HARNESS_SERVER_RUNNER:-} ]]; then
    if [[ "$provider_auth_mode" == subscription ]]; then
      "${clean_server_env[@]}" "$T3_STOCK_HARNESS_SERVER_RUNNER" "$provider_auth_mode" "$claude_executable" "$claude_version"
    else
      "${clean_server_env[@]}" "ANTHROPIC_API_KEY=$provider_key" "$T3_STOCK_HARNESS_SERVER_RUNNER" "$provider_auth_mode" '' ''
    fi
  fi
  unset provider_key
elif [[ "$provider_auth_mode" == subscription ]]; then
  (cd "$workspace" && exec "${clean_server_env[@]}" node "$stock_tree/apps/server/dist/bin.mjs" serve --host 127.0.0.1 --port 3774 --base-dir "$server_home") >"$server_log" 2>&1 &
  server_pid=$!
  server_birth=$(/bin/ps -o lstart= -p "$server_pid" | /usr/bin/xargs)
  unset provider_key
  server_cwd=$(/usr/sbin/lsof -a -p "$server_pid" -d cwd -Fn | /usr/bin/sed -n 's/^n//p')
  [[ "$server_cwd" == "$workspace" ]]
else
  (cd "$workspace" && exec "${clean_server_env[@]}" "ANTHROPIC_API_KEY=$provider_key" node "$stock_tree/apps/server/dist/bin.mjs" serve --host 127.0.0.1 --port 3774 --base-dir "$server_home") >"$server_log" 2>&1 &
  server_pid=$!
  server_birth=$(/bin/ps -o lstart= -p "$server_pid" | /usr/bin/xargs)
  unset provider_key
  server_cwd=$(/usr/sbin/lsof -a -p "$server_pid" -d cwd -Fn | /usr/bin/sed -n 's/^n//p')
  [[ "$server_cwd" == "$workspace" ]]
fi
run_stage_seam after-server-launch

ready=false
if [[ "$test_mode" == 1 ]]; then
  ready=true
else
  for _attempt in {1..30}; do
    /bin/kill -0 "$server_pid" 2>/dev/null || break
    descriptor_body=$(/usr/bin/curl --silent --fail --max-time 0.5 http://127.0.0.1:3774/.well-known/t3/environment 2>/dev/null || true)
    if /usr/bin/jq -e 'type == "object" and (.environmentId|type == "string" and length > 0) and (.serverVersion|type == "string" and length > 0)' <<<"$descriptor_body" >/dev/null 2>&1; then
      ready=true
      break
    fi
    sleep 0.5
  done
fi
[[ "$ready" == true ]]
run_stage_seam after-readiness

if [[ "$test_mode" == 1 ]]; then
  negative_shell_status=200
  negative_detail_status=404
else
  negative_thread_id=$(/usr/bin/uuidgen | /usr/bin/tr '[:upper:]' '[:lower:]')
  negative_command_id=$(/usr/bin/uuidgen | /usr/bin/tr '[:upper:]' '[:lower:]')
  negative_message_id=$(/usr/bin/uuidgen | /usr/bin/tr '[:upper:]' '[:lower:]')
  negative_body="$proof_root/exact-http-negative.json"
  : >"$negative_body"
  chmod 600 "$negative_body"
  negative_request="$proof_root/exact-http-negative-input.json"
  /usr/bin/jq -n \
  --arg commandId "$negative_command_id" \
  --arg threadId "$negative_thread_id" \
  --arg messageId "$negative_message_id" \
  --arg createdAt "$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')" \
  --arg workspace "$workspace" \
  '{type:"thread.turn.start",commandId:$commandId,threadId:$threadId,message:{messageId:$messageId,role:"user",text:"negative",attachments:[]},runtimeMode:"full-access",interactionMode:"default",bootstrap:{createThread:{projectId:"00000000-0000-4000-8000-000000000000",title:"negative",modelSelection:{instanceId:"claudeAgent",model:"claude-sonnet-4-5"},runtimeMode:"full-access",interactionMode:"default",branch:null,worktreePath:null,createdAt:$createdAt}},createdAt:$createdAt}' >"$negative_request"
  chmod 600 "$negative_request"
negative_status=$(authenticated_curl --silent --show-error --output "$negative_body" --write-out '%{http_code}' \
  --max-time 5 \
  --request POST \
  --header 'Content-Type: application/json' \
  --data-binary "@$negative_request" \
  http://127.0.0.1:3774/api/orchestration/dispatch)
  if [[ "$negative_status" != 500 ]] || ! /usr/bin/jq -e '.code == "internal_error" and .reason == "orchestration_dispatch_failed"' "$negative_body" >/dev/null; then
  echo "ERROR: exact HTTP bootstrap negative did not match stock" >&2
  exit 2
fi
negative_shell_body="$proof_root/negative-shell.json"
negative_shell_status=$(authenticated_curl --silent --show-error --output "$negative_shell_body" --write-out '%{http_code}' \
  --max-time 5 \
  http://127.0.0.1:3774/api/orchestration/shell)
negative_detail_body="$proof_root/negative-detail.json"
negative_detail_status=$(authenticated_curl --silent --show-error --output "$negative_detail_body" --write-out '%{http_code}' \
  --max-time 5 \
  "http://127.0.0.1:3774/api/orchestration/threads/$negative_thread_id")
  if [[ "$negative_shell_status" != 200 || "$negative_detail_status" != 404 ]] || /usr/bin/jq -e --arg id "$negative_thread_id" '.threads[]? | select(.id == $id)' "$negative_shell_body" >/dev/null; then
  echo "ERROR: direct HTTP bootstrap unexpectedly created a thread" >&2
  exit 2
  fi
fi
run_stage_seam after-http-negative

prepare_projection_trace
export T3_STOCK_BASE_URL=http://127.0.0.1:3774
export T3_STOCK_HTTP_TOKEN="$http_token"
export T3_STOCK_WORKSPACE_ROOT="$workspace"
export T3_STOCK_RECEIPT_PATH="$provisional"
export T3_STOCK_RUN_ID="$run_id"
if [[ "$test_mode" == 1 ]]; then
  provisional_json=$(/usr/bin/jq -cS -n --arg runId "$run_id" '{provisional:true,success:false,runId:$runId,environmentId:"environment-fixture",serverVersion:"stock",endpointStatusTrace:[{method:"GET",path:"/.well-known/t3/environment",status:200},{method:"GET",path:"/api/orchestration/shell",status:200},{method:"GET",path:"/api/orchestration/shell",status:200},{method:"GET",path:"/api/orchestration/shell",status:200},{method:"GET",path:"/api/orchestration/threads/thread-id",status:200},{method:"GET",path:"/api/orchestration/threads/thread-id",status:200},{method:"POST",path:"/api/orchestration/dispatch",status:200},{method:"POST",path:"/api/orchestration/dispatch",status:200},{method:"POST",path:"/api/orchestration/dispatch",status:200}],ids:{projectId:"project-id",threadId:"thread-id",createCommandId:"create-id",initialCommandId:"initial-id",initialMessageId:"initial-message",followupCommandId:"followup-id",followupMessageId:"followup-message"},sequences:{create:1,initial:2,followup:3},counters:{requests:9,shellPolls:3,detailPolls:2,peakInFlight:1},terminalKinds:["completed","completed"],timestamps:{startedAt:"2026-07-31T00:00:00.000Z",completedAt:"2026-07-31T00:01:00.000Z"}}')
  printf '%s\n' "$provisional_json" >"$provisional"
else
  (cd "$t3layer_clean" && T3_STOCK_LIVE=1 bun test test/stock-t3-live.test.ts --timeout 120000)
fi
run_stage_seam after-live-test

if [[ "$test_mode" != 1 ]]; then
  bun "$t3layer_clean/scripts/stock-proof-cli.ts" validate-provisional "$provisional" "$run_id"
fi
run_stage_seam after-provisional-validation

if [[ "$test_mode" != 1 ]]; then
  provisional_json=$(/usr/bin/jq -cS \
    --arg runId "$run_id" \
    'select(.provisional == true and .success == false and .runId == $runId)' \
    "$provisional")
fi
if [[ -z "$provisional_json" ]]; then
  echo "ERROR: invalid live provisional evidence" >&2
  exit 2
fi
proof_ready=true
run_stage_seam before-normal-exit
echo "LIVE PROVISIONAL WRITTEN runId=$run_id candidateSha=$candidate_sha artifactDigest=$artifact_digest target=$proof_target"
