# Integration-test bridge container: rosbridge_server + foxglove_bridge on ROS 2 Jazzy.
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
    && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# rosbridge_server (JSON) and foxglove_bridge (binary) over one ROS graph.
EXPOSE 9090 8765

ENTRYPOINT ["/entrypoint.sh"]
