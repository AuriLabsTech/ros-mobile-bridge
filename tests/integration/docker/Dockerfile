# Integration-test bridge container: rosbridge_server + foxglove_bridge on ROS 2
# Jazzy, plus a Foxglove SDK server publishing the SDK's protobuf channels.
#
# The base image is pinned by digest deliberately. Bumping it (or the bridge
# packages that apt resolves against it) is a deliberate PR with a rationale,
# never a floating-tag drift. See tests/integration/README.md.
FROM ros:jazzy@sha256:31daab66eef9139933379fb67159449944f4e2dcf2e22c2d12cc715f29873e0f

# python3-ujson is intentional, not incidental: rosbridge_server switches its
# wire serializer to ujson when importable, which escapes '/' as '\/' in
# outbound frames. That serializer is part of the regression surface these
# tests exist to cover, so the fixture asserts its presence at startup.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ros-jazzy-rosbridge-suite \
    ros-jazzy-foxglove-bridge \
    python3-ujson \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

# The Foxglove SDK, pinned by version like the bridges are by digest. Ubuntu
# 24.04 marks its system Python externally managed (PEP 668), hence the venv.
# PyPI ships prebuilt cp310-abi3 wheels for x86_64 and aarch64, so this is a
# download, not a build.
RUN python3 -m venv /opt/foxglove-sdk \
    && /opt/foxglove-sdk/bin/pip install --no-cache-dir foxglove-sdk==0.27.0

COPY entrypoint.sh /entrypoint.sh
COPY sdk_server.py /sdk_server.py
RUN chmod +x /entrypoint.sh

# rosbridge_server (JSON) and foxglove_bridge (binary) over one ROS graph, and
# the SDK server (protobuf), which is not on the ROS graph at all.
EXPOSE 9090 8765 8766

ENTRYPOINT ["/entrypoint.sh"]
