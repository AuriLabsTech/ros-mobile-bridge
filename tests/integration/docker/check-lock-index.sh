#!/bin/bash
# Compares every pinned row of bridge-versions.lock with the packages.ros.org
# index, for all distros in one run, without building an image.
#
# Usage: check-lock-index.sh [lock file]
#
# check-bridge-versions.sh stops one image build at a time, and upstream
# releases reach each distro's index on different days. Run this on a red
# version check to see the drift on every distro at once and fix it in one
# change. Rows pinned to "latest" are skipped. It reads the amd64 index, the
# one CI's images install from; a local image on Apple Silicon installs arm64,
# which the buildfarm can release on another day.
#
# For the unit test: RMB_INDEX_DIR, when set, is a folder of plain
# "<suite>.Packages" files read instead of the network, and RMB_INDEX_URL
# replaces the packages.ros.org dists URL.
set -eu -o pipefail

lock="${1:-$(dirname "$0")/bridge-versions.lock}"
index_url="${RMB_INDEX_URL:-http://packages.ros.org/ros2/ubuntu/dists}"

# The Ubuntu release each distro's packages build on. A new distro in the
# lock needs a line here.
suite_of() {
  case "$1" in
    humble) echo jammy ;;
    jazzy | kilted) echo noble ;;
    lyrical) echo resolute ;;
    *) return 1 ;;
  esac
}

# Same rule as check-bridge-versions.sh: "3.6.3-1noble.20261105.114855" ->
# "3.6.3-1", the build stamp dropped.
release_of() {
  printf '%s\n' "$1" | sed -E 's/^(.*-[0-9]+)[^0-9].*$/\1/'
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Prints the path of a plain-text Packages index for the suite. An index that
# cannot be read in full stops the run: read as empty, it would report every
# package of the suite as missing upstream.
index_for() {
  if [ -n "${RMB_INDEX_DIR:-}" ]; then
    if [ ! -r "$RMB_INDEX_DIR/$1.Packages" ]; then
      echo "check-lock-index: could not read the $1 index from $RMB_INDEX_DIR" >&2
      return 1
    fi
    echo "$RMB_INDEX_DIR/$1.Packages"
    return
  fi
  local file="$work/$1.Packages"
  if [ ! -f "$file" ]; then
    local url="$index_url/$1/main/binary-amd64/Packages.gz"
    if ! curl -fsSL "$url" | gzip -dc > "$file.part"; then
      echo "check-lock-index: could not read the $1 index from $url" >&2
      return 1
    fi
    mv "$file.part" "$file"
  fi
  echo "$file"
}

failed=0
while read -r distro pkg want || [ -n "${distro:-}" ]; do
  case "$distro" in '' | '#'*) continue ;; esac
  if [ "$pkg" = base ] || [ "$want" = latest ]; then continue; fi
  if ! suite=$(suite_of "$distro"); then
    echo "check-lock-index: no Ubuntu suite for distro '$distro'; add it to suite_of in $0" >&2
    failed=1
    continue
  fi
  index=$(index_for "$suite") || exit 1
  have=$(awk -v p="$pkg" '/^Package: /{cur=$2} /^Version: /{ if (cur == p) { print $2; exit } }' "$index" 2>/dev/null || true)
  if [ -z "$have" ]; then
    echo "check-lock-index: $distro $pkg: not in the $suite index (lock: $want)" >&2
    failed=1
    continue
  fi
  got=$(release_of "$have")
  if [ "$got" = "$want" ]; then
    echo "check-lock-index: $distro $pkg $got ok"
  else
    echo "check-lock-index: $distro $pkg: index has $got, lock says $want" >&2
    failed=1
  fi
done < "$lock"

if [ "$failed" -ne 0 ]; then
  echo "check-lock-index: the lock and the index differ. Update $lock in one reviewed change." >&2
  exit 1
fi
