# Integration-test bridge container: rosbridge_server + foxglove_bridge on one
# ROS 2 distro, plus a Foxglove SDK server publishing the SDK's protobuf channels.
#
# Build it through build.sh <distro>, which reads the base image and the
# package releases from bridge-versions.lock. The base image is pinned by
# digest and the bridge releases are checked after install, so a bump is a
# reviewed change to the lock file, never drift. See tests/integration/README.md.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

# The distro the lock rows were chosen for. Not named ROS_DISTRO: the base
# image sets that as ENV, which would shadow a build argument of the same name.
ARG LOCK_DISTRO

# This distro's rows of bridge-versions.lock, from build.sh. Every RUN below
# depends on it, so a lock bump rebuilds the install layer; otherwise the
# cached layer keeps the old release and the version check refuses it.
ARG LOCK_ROWS

# python3-ujson is intentional, not incidental: rosbridge_server switches its
# wire serializer to ujson when importable, which escapes '/' as '\/' in
# outbound frames. That serializer is part of the regression surface these
# tests exist to cover, so the fixture asserts its presence at startup.
#
# The two extra RMWs back the RMW_IMPLEMENTATION switch in entrypoint.sh.
# Fast DDS, the default, ships with the base image.
RUN test "$LOCK_DISTRO" = "$ROS_DISTRO" \
      || { echo "lock distro '$LOCK_DISTRO' does not match the base image's '$ROS_DISTRO'" >&2; exit 1; } \
    && apt-get update && apt-get install -y --no-install-recommends \
    ros-${ROS_DISTRO}-rosbridge-suite \
    ros-${ROS_DISTRO}-foxglove-bridge \
    ros-${ROS_DISTRO}-rmw-cyclonedds-cpp \
    ros-${ROS_DISTRO}-rmw-zenoh-cpp \
    python3-ujson \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

# The lock is copied after the install, so editing one distro's rows does not
# throw away the other distros' cached install layers.
COPY bridge-versions.lock check-bridge-versions.sh /opt/rmb/
RUN bash /opt/rmb/check-bridge-versions.sh /opt/rmb/bridge-versions.lock "$ROS_DISTRO"

# The Foxglove SDK, pinned by version. Ubuntu marks its system Python
# externally managed (PEP 668) from 24.04 on, hence the venv. PyPI ships
# prebuilt cp310-abi3 wheels for x86_64 and aarch64, so this is a download,
# not a build.
RUN python3 -m venv /opt/foxglove-sdk \
    && /opt/foxglove-sdk/bin/pip install --no-cache-dir foxglove-sdk==0.27.0

COPY entrypoint.sh /entrypoint.sh
COPY sdk_server.py /sdk_server.py
COPY fixture_nodes.py /fixture_nodes.py
RUN chmod +x /entrypoint.sh

# rosbridge_server (JSON) and foxglove_bridge (binary) over one ROS graph, and
# the SDK server (protobuf), which is not on the ROS graph at all.
EXPOSE 9090 8765 8766

ENTRYPOINT ["/entrypoint.sh"]
