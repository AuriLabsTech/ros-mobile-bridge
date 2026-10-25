#!/bin/bash
# Fails the image build when apt installed a package release other than the
# one bridge-versions.lock lists for this distro.
#
# Usage: check-bridge-versions.sh <lock file> <distro>
#
# A row whose release is "latest" passes with whatever apt installed, and
# prints it, so the build log says which release the suite ran against.
#
# Compares the release only: upstream version plus Debian revision ("3.6.0-1").
# A Debian version on packages.ros.org reads "3.6.0-1noble.20260929.221626";
# the part after the revision is the buildfarm's build stamp, which changes
# whenever the farm rebuilds the same release. A check on the full string
# would go red on every such rebuild with no code change.
set -eu

lock="$1"
distro="$2"

# "3.6.0-1noble.20260929.221626" -> "3.6.0-1". The revision is the digits
# after the last '-'; everything from the first non-digit after it is the stamp.
release_of() {
  printf '%s\n' "$1" | sed -E 's/^(.*-[0-9]+)[^0-9].*$/\1/'
}

rows=$(awk -v d="$distro" '$1 == d && $2 != "base" { print $2, $3 }' "$lock")
if [ -z "$rows" ]; then
  echo "check-bridge-versions: no package rows for distro '$distro' in $lock" >&2
  exit 1
fi

failed=0
while read -r pkg want; do
  have=$(dpkg-query -W -f='${Version}' "$pkg" 2>/dev/null || true)
  if [ -z "$have" ]; then
    echo "check-bridge-versions: $pkg is not installed (lock: $want)" >&2
    failed=1
    continue
  fi
  got=$(release_of "$have")
  if [ "$want" = "latest" ]; then
    echo "check-bridge-versions: $pkg $got (latest, not pinned)"
  elif [ "$got" = "$want" ]; then
    echo "check-bridge-versions: $pkg $got ok"
  else
    echo "check-bridge-versions: $pkg is $got ($have), lock says $want" >&2
    failed=1
  fi
done <<EOF
$rows
EOF

if [ "$failed" -ne 0 ]; then
  echo "check-bridge-versions: the apt index moved. Update $lock in a reviewed change and re-check the per-distro differences." >&2
  exit 1
fi
