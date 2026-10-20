#!/bin/bash
# Builds the integration bridge image for one ROS 2 distro, from the base
# image and package releases bridge-versions.lock lists for it.
#
# Usage: build.sh <distro>      (humble, jazzy, kilted, rolling)
# Produces: rmb-integration-bridge:<distro>
#
# The integration suite calls this itself; run it by hand to build an image
# for something else, such as a test rig that starts FROM it.
set -eu

distro="${1:?usage: build.sh <distro>}"
here="$(cd "$(dirname "$0")" && pwd)"
lock="$here/bridge-versions.lock"

base=$(awk -v d="$distro" '$1 == d && $2 == "base" { print $3 }' "$lock")
if [ -z "$base" ]; then
  known=$(awk '$2 == "base" { printf "%s ", $1 }' "$lock")
  echo "build.sh: no distro '$distro' in $lock (known: $known)" >&2
  exit 1
fi

# This distro's lock rows, passed so that editing them rebuilds this distro's
# install layer (and only this distro's) instead of reusing the cached one.
rows=$(awk -v d="$distro" '$1 == d' "$lock")

exec docker build \
  --build-arg "BASE_IMAGE=$base" \
  --build-arg "LOCK_DISTRO=$distro" \
  --build-arg "LOCK_ROWS=$rows" \
  -t "rmb-integration-bridge:$distro" \
  "$here"
