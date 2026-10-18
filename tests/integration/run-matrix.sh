#!/bin/bash
# Runs the integration suite on every combination CI runs, one after
# another, and prints one result line per combination.
#
# Usage: npm run test:integration:matrix
#
# Distros come from docker/bridge-versions.lock, each on the default
# middleware. The two other middlewares run on Jazzy only, as in the
# integration job of .github/workflows/ci.yml; keep the two lists in step.
# Each run's full output goes to a log file whose path is printed at the end.
# Beside it, a .load.log holds the host load and the running containers at
# the start and end of that run, so a timeout can be told apart from a busy
# machine after the fact.
set -u

load_snapshot() {
  echo "== $1 $(date '+%H:%M:%S')"
  uptime
  docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}' 2>&1
}

here="$(cd "$(dirname "$0")" && pwd)"
lock="$here/docker/bridge-versions.lock"
[ -f "$lock" ] || { echo "run-matrix.sh: $lock not found" >&2; exit 1; }
tmp="${TMPDIR:-/tmp}"
logs="$(mktemp -d "${tmp%/}/rmb-integration-matrix.XXXXXX")"

combos=()
for distro in $(awk '$2 == "base" { print $1 }' "$lock"); do
  combos+=("$distro rmw_fastrtps_cpp")
done
combos+=("jazzy rmw_cyclonedds_cpp" "jazzy rmw_zenoh_cpp")

failed=0
for combo in "${combos[@]}"; do
  read -r distro rmw <<<"$combo"
  log="$logs/$distro-$rmw.log"
  load_snapshot start >"$logs/$distro-$rmw.load.log"
  if RMB_ROS_DISTRO="$distro" RMB_RMW="$rmw" npm run --silent test:integration >"$log" 2>&1; then
    result="ok  "
  else
    result="FAIL"
    failed=1
  fi
  load_snapshot end >>"$logs/$distro-$rmw.load.log"
  summary=$(sed -E 's/\x1b\[[0-9;]*m//g' "$log" | grep -E '^ +Tests +' | tail -1 | sed -E 's/^ +//')
  printf '%s %-8s %-19s %s\n' "$result" "$distro" "$rmw" "${summary:-no test summary, see the log}"
done

echo "logs: $logs"
exit "$failed"
