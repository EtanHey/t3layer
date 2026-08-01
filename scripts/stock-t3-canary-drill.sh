#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: stock-t3-canary-drill.sh --dry-run|--execute" >&2
}

mode=${1:-}
transitions='off -> canary -> promoted -> canary (prior config) -> off'

if [[ "$mode" == "--dry-run" ]]; then
  echo "STOCK_T3_CANARY_DRILL: DRY_RUN"
  echo "$transitions"
  echo "schema=stock-http-v1 acceleration=off artifact=unchanged"
  echo "release_blocked=true reason=operator_commands_not_executed"
  exit 0
fi
if [[ "$mode" != "--execute" ]]; then
  usage
  exit 2
fi

: "${T3_STOCK_ROUTE_OFF_COMMAND:?required executable path}"
: "${T3_STOCK_ROUTE_CANARY_COMMAND:?required executable path}"
: "${T3_STOCK_ROUTE_PROMOTE_COMMAND:?required executable path}"
: "${T3_STOCK_ROUTE_PRIOR_CONFIG_COMMAND:?required executable path}"
: "${T3_STOCK_READINESS_COMMAND:?required executable path}"
: "${T3_STOCK_DESCRIPTOR_COMMAND:?required executable path}"
: "${T3_STOCK_THREAD_READ_COMMAND:?required executable path}"
: "${T3_STOCK_CANCEL_WAITS_COMMAND:?required executable path}"
: "${T3_STOCK_ARTIFACT_PATH:?required artifact path}"
: "${T3_STOCK_CONFIG_PATH:?required redacted config path}"
: "${T3_STOCK_APPROVED_ARTIFACT_SHA256:?required approved artifact SHA-256}"
: "${T3_STOCK_APPROVED_CONFIG_SHA256:?required approved config SHA-256}"
: "${T3_STOCK_DRILL_RECEIPT_PATH:?required receipt path}"

sha256_file() {
  local path=$1
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$path" | /usr/bin/awk '{print $1}'
  else
    shasum -a 256 "$path" | /usr/bin/awk '{print $1}'
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

commands=(
  "$T3_STOCK_ROUTE_OFF_COMMAND"
  "$T3_STOCK_ROUTE_CANARY_COMMAND"
  "$T3_STOCK_ROUTE_PROMOTE_COMMAND"
  "$T3_STOCK_ROUTE_PRIOR_CONFIG_COMMAND"
  "$T3_STOCK_READINESS_COMMAND"
  "$T3_STOCK_DESCRIPTOR_COMMAND"
  "$T3_STOCK_THREAD_READ_COMMAND"
  "$T3_STOCK_CANCEL_WAITS_COMMAND"
)
for command_path in "${commands[@]}"; do
  if [[ ! -x "$command_path" ]]; then
    echo "ERROR: operator command is not executable" >&2
    exit 2
  fi
done
if [[ ! -f "$T3_STOCK_ARTIFACT_PATH" || ! -f "$T3_STOCK_CONFIG_PATH" ]]; then
  echo "ERROR: artifact/config must be files" >&2
  exit 2
fi

artifact_digest=$(sha256_file "$T3_STOCK_ARTIFACT_PATH")
config_before=$(sha256_file "$T3_STOCK_CONFIG_PATH")
if [[ "$artifact_digest" != "$T3_STOCK_APPROVED_ARTIFACT_SHA256" || "$config_before" != "$T3_STOCK_APPROVED_CONFIG_SHA256" ]]; then
  echo "ERROR: approved digest mismatch" >&2
  exit 2
fi
command_statuses='[]'
descriptor_evidence='[]'
thread_evidence='[]'
drill_complete=false
recovery_armed=true
artifact_evidence='[]'
expected_environment_id=''
expected_thread_id=''
cancellation_evidence=''

verify_artifact() {
  local artifact_stage=$1
  local current_digest
  current_digest=$(sha256_file "$T3_STOCK_ARTIFACT_PATH")
  artifact_evidence=$(/usr/bin/jq -c --arg stage "$artifact_stage" --arg digest "$current_digest" '. + [{stage:$stage,digest:$digest}]' <<<"$artifact_evidence")
  if [[ "$current_digest" != "$artifact_digest" ]]; then
    echo "ERROR: artifact drift detected at $artifact_stage" >&2
    return 2
  fi
}

record_status() {
  if [[ ${T3_STOCK_FAIL_STATUS_AT:-} == "$1" ]]; then
    echo "ERROR: injected status-record failure: $1" >&2
    return 92
  fi
  command_statuses=$(/usr/bin/jq -c --arg name "$1" --argjson status "$2" '. + [{name:$name,status:$status}]' <<<"$command_statuses")
}

run_step() {
  local step_name=$1
  local step_command=$2
  local step_status=0
  "$step_command" || step_status=$?
  record_status "$step_name" "$step_status"
  if [[ "$step_status" -ne 0 ]]; then return "$step_status"; fi
  if [[ ${T3_STOCK_FAIL_AT:-} == "$step_name" ]]; then
    echo "ERROR: injected transition failure: $step_name" >&2
    return 91
  fi
  verify_artifact "$step_name"
}

recover() {
  local exit_status=$?
  if [[ $# -eq 1 ]]; then exit_status=$1; fi
  trap - EXIT INT TERM
  set +e
  if [[ "$drill_complete" != true && "$recovery_armed" == true ]]; then
    local prior_status=0
    "$T3_STOCK_ROUTE_PRIOR_CONFIG_COMMAND" || prior_status=$?
    record_status recovery-prior-config "$prior_status"
    local off_status=0
    "$T3_STOCK_ROUTE_OFF_COMMAND" || off_status=$?
    record_status recovery-off "$off_status"
    local cancel_status=0
    "$T3_STOCK_CANCEL_WAITS_COMMAND" >/dev/null || cancel_status=$?
    record_status recovery-cancel-waits "$cancel_status"
    echo "CANARY_RECOVERY: prior_config=$prior_status routing_off=$off_status cancel_waits=$cancel_status" >&2
  fi
  exit "$exit_status"
}

handle_signal() {
  recover "$1"
}

# Recovery is armed before the first routing mutation.
trap recover EXIT
trap 'handle_signal 130' INT
trap 'handle_signal 143' TERM

verify_health() {
  local stage=$1
  local descriptor current_environment_id thread current_thread_id
  run_step "$stage-readiness" "$T3_STOCK_READINESS_COMMAND"
  descriptor=$("$T3_STOCK_DESCRIPTOR_COMMAND")
  if ! /usr/bin/jq -e 'type == "object" and (.environmentId|type == "string" and length > 0) and (.serverVersion|type == "string" and length > 0)' <<<"$descriptor" >/dev/null; then
    echo "ERROR: invalid descriptor evidence" >&2
    return 2
  fi
  descriptor_evidence=$(/usr/bin/jq -c --arg stage "$stage" --argjson value "$descriptor" '. + [{stage:$stage,environmentId:$value.environmentId,serverVersion:$value.serverVersion}]' <<<"$descriptor_evidence")
  current_environment_id=$(/usr/bin/jq -r '.environmentId' <<<"$descriptor")
  if [[ -z "$expected_environment_id" ]]; then
    expected_environment_id=$current_environment_id
  elif [[ "$current_environment_id" != "$expected_environment_id" ]]; then
    echo "ERROR: environment identity changed during drill" >&2
    return 2
  fi
  record_status "$stage-descriptor" 0
  if [[ ${T3_STOCK_FAIL_AT:-} == "$stage-descriptor" ]]; then return 91; fi
  thread=$("$T3_STOCK_THREAD_READ_COMMAND")
  if ! /usr/bin/jq -e 'type == "object" and (.threadId|type == "string" and length > 0) and .readable == true' <<<"$thread" >/dev/null; then
    echo "ERROR: existing thread is not readable" >&2
    return 2
  fi
  thread_evidence=$(/usr/bin/jq -c --arg stage "$stage" --argjson value "$thread" '. + [{stage:$stage,threadId:$value.threadId,readable:true}]' <<<"$thread_evidence")
  current_thread_id=$(/usr/bin/jq -r '.threadId' <<<"$thread")
  if [[ -z "$expected_thread_id" ]]; then
    expected_thread_id=$current_thread_id
  elif [[ "$current_thread_id" != "$expected_thread_id" ]]; then
    echo "ERROR: canonical thread identity changed during drill" >&2
    return 2
  fi
  record_status "$stage-thread" 0
  if [[ ${T3_STOCK_FAIL_AT:-} == "$stage-thread" ]]; then return 91; fi
  verify_artifact "$stage-health"
}

run_step route-off "$T3_STOCK_ROUTE_OFF_COMMAND"
run_step route-canary "$T3_STOCK_ROUTE_CANARY_COMMAND"
verify_health canary
run_step route-promote "$T3_STOCK_ROUTE_PROMOTE_COMMAND"
verify_health promoted
run_step restore-prior-config "$T3_STOCK_ROUTE_PRIOR_CONFIG_COMMAND"
config_after_restore=$(sha256_file "$T3_STOCK_CONFIG_PATH")
if [[ "$config_after_restore" != "$config_before" ]]; then
  echo "ERROR: prior configuration digest was not restored" >&2
  exit 2
fi
run_step route-prior-canary "$T3_STOCK_ROUTE_CANARY_COMMAND"
verify_health prior-canary
run_step final-route-off "$T3_STOCK_ROUTE_OFF_COMMAND"
cancellation_status=0
cancellation_evidence=$("$T3_STOCK_CANCEL_WAITS_COMMAND") || cancellation_status=$?
record_status cancel-waits "$cancellation_status"
if [[ "$cancellation_status" -ne 0 ]] || ! /usr/bin/jq -e 'type == "object" and (.cancelled|type == "number" and . >= 0) and .replayed == 0' <<<"$cancellation_evidence" >/dev/null; then
  echo "ERROR: invalid cancellation/no-replay evidence" >&2
  exit 2
fi
if [[ ${T3_STOCK_FAIL_AT:-} == cancel-waits ]]; then
  echo "ERROR: injected transition failure: cancel-waits" >&2
  exit 91
fi
verify_artifact cancel-waits
config_after=$(sha256_file "$T3_STOCK_CONFIG_PATH")
[[ "$config_after" == "$config_before" ]]

receipt_dir=$(dirname "$T3_STOCK_DRILL_RECEIPT_PATH")
mkdir -p -- "$receipt_dir"
body_staging=$(mktemp "$receipt_dir/.stock-t3-drill-body.XXXXXX")
staging=$(mktemp "$receipt_dir/.stock-t3-drill.XXXXXX")
chmod 600 "$body_staging" "$staging"
/usr/bin/jq -cS -n \
  --arg transitions "$transitions" \
  --arg digest "$artifact_digest" \
  --arg before "$config_before" \
  --arg after "$config_after" \
  --argjson statuses "$command_statuses" \
  --argjson descriptors "$descriptor_evidence" \
  --argjson threads "$thread_evidence" \
  --argjson artifacts "$artifact_evidence" \
  --argjson cancellation "$cancellation_evidence" \
  '{success:true,transitions:$transitions,artifactDigest:$digest,configDigestBefore:$before,configDigestAfter:$after,schema:"stock-http-v1",acceleration:"off",cancellation:$cancellation,commandStatuses:$statuses,descriptors:$descriptors,threadReadability:$threads,artifactChecks:$artifacts}' >"$body_staging"
checksum=$(sha256_file "$body_staging")
/usr/bin/jq -cS --arg checksum "$checksum" '. + {checksum:$checksum}' "$body_staging" >"$staging"
mv -f -- "$staging" "$T3_STOCK_DRILL_RECEIPT_PATH"
chmod 600 "$T3_STOCK_DRILL_RECEIPT_PATH"
rm -f -- "$body_staging"
if [[ $(file_mode "$T3_STOCK_DRILL_RECEIPT_PATH") != 600 ]]; then
  echo "ERROR: canary receipt mode mismatch" >&2
  exit 2
fi
reread_body=$(mktemp "$receipt_dir/.stock-t3-drill-reread.XXXXXX")
/usr/bin/jq -cS 'del(.checksum)' "$T3_STOCK_DRILL_RECEIPT_PATH" >"$reread_body"
reread_checksum=$(sha256_file "$reread_body")
rm -f -- "$reread_body"
if [[ "$reread_checksum" != "$checksum" ]] || ! /usr/bin/jq -e --arg checksum "$checksum" '.success == true and .schema == "stock-http-v1" and .acceleration == "off" and .checksum == $checksum and .cancellation.replayed == 0' "$T3_STOCK_DRILL_RECEIPT_PATH" >/dev/null; then
  echo "ERROR: canary receipt checksum or reread mismatch" >&2
  exit 2
fi
drill_complete=true
recovery_armed=false
trap - EXIT INT TERM
echo "STOCK_T3_CANARY_DRILL: PASS"
