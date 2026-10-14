# Integration tests

Protocol-conformance tests that run the library against real, pinned bridge
servers instead of the `MockWebSocket` harness: `rosbridge_server` and
`foxglove_bridge` from one ROS 2 distro (Humble, Jazzy, Kilted or Rolling),
and a Foxglove SDK server, inside one Docker Compose container.

The unit suite proves the library implements the protocol we understood.
This suite proves that understanding against the servers themselves. The
motivating case: a stock `rosbridge_server` serializes with ujson, which
escapes `/` as `\/` on the wire. No mock surfaced that; a pinned container
would have caught it before any consumer did.

## Running

```bash
npm run test:integration
```

Requirements: a running Docker daemon with Compose v2. The first run builds
the bridge image (a few minutes); later runs reuse the cached layers. The
default `npm test` never touches Docker, and this suite is excluded from it.

Two environment variables pick what the suite runs against:

- `RMB_ROS_DISTRO`: `humble`, `jazzy` (default), `kilted` or `rolling`, any
  distro listed in `docker/bridge-versions.lock`.
- `RMB_RMW`: the middleware under the ROS graph, `rmw_fastrtps_cpp`
  (default), `rmw_cyclonedds_cpp` or `rmw_zenoh_cpp`. With Zenoh the
  container starts the Zenoh router before any node.

```bash
RMB_ROS_DISTRO=humble RMB_RMW=rmw_cyclonedds_cpp npm run test:integration
```

CI runs every distro on the default middleware, and the other two
middlewares on Jazzy, on every push, every pull request and once a week.
`npm run test:integration:matrix` runs the same combinations locally, one
after another, and prints one result line for each. Each takes about two
minutes once its image is built.

Host ports are ephemeral and each distro and middleware pair gets its own
compose project, so the suite can run next to anything else, including a
second copy of itself. Set `RMB_INTEGRATION_KEEP=1` to leave the container
running after a run for debugging; tear it down with
`docker compose -p rmb-integration-<distro>-<rmw> -f tests/integration/docker/compose.yaml down -v`,
where `<rmw>` is the middleware name with dashes (`rmw-fastrtps-cpp`).

## What is covered

- Discovery and delivery through real ujson-escaped frames, in both dispatch
  modes (the 0.1.6 regression surface, RMB-46).
- Type-less subscribe against a live topic (rosbridge resolves the type).
- Subscribe before the topic or channel exists, then start the publisher:
  pending-to-active activation and delivery on both transports (RMB-49,
  RMB-51), observed through `getSubscriptionState`.
- Hinted subscribe (`SubscribeOptions.schemaName`) on a not-yet-published
  topic.
- Aborting a connection attempt against a real server (`ConnectOptions.signal`).
- Protobuf decoding against a real Foxglove SDK server: the SDK's own
  `CompressedImage` and `FrameTransform` channels, decoded from the
  `FileDescriptorSet` the server advertises.

## Fixture layout

- `docker/`: the pinned image. `build.sh <distro>` builds
  `rmb-integration-bridge:<distro>` from the Dockerfile and the lock file;
  the suite calls it, and anything else that wants the same image (a test
  rig starting `FROM` it) can too. One
  container runs both bridges plus a steady `/chatter` publisher on a fixed,
  non-default `ROS_DOMAIN_ID`, and `sdk_server.py`, a Foxglove SDK server on
  port 8766 publishing fixed values on `/sdk/image` and `/sdk/tf`. A second
  `foxglove_bridge` on port 8767 runs with `include_hidden:=true`, which
  action goals over Foxglove need; the one on 8765 keeps the launch defaults.
- `helpers/fixture.ts`: compose control, in-container publishers, the ujson
  presence assert.
- `helpers/readiness.ts`: protocol-level readiness. TCP-accept is not
  readiness; ready means rosapi answers and live frames flow. Implemented on
  raw WebSocket so fixture health is never certified by the library under
  test.
- `globalSetup.ts`: boots the fixture once per run and injects the resolved
  URLs into the tests.

## rosbridge launch arguments on Humble

The fixture starts `rosbridge_server` with `call_services_in_new_thread:=true`
and `send_action_goals_in_new_thread:=true` on every distro. Both default to
`true` from Jazzy on and to `false` on Humble (`rosbridge_server` 2.0.8).

With them off, rosbridge works through a connection's operations one at a
time: a running action goal holds every later operation on that connection,
its cancel included, until the goal ends. Measured on the Humble image
(2026-10-14): a cancel sent 1.5 s into a 10 s goal was answered at 10.6 s,
after the goal had succeeded, and a `/rosapi/get_time` call sent with it
waited just as long. The same exchange on Jazzy answered in 70 ms and the
goal ended canceled. No client can work around this on the same connection,
so a Humble robot that needs to cancel goals has to launch rosbridge with
both arguments set to `true`. The suite tests that configuration.

## Version pinning policy

`docker/bridge-versions.lock` is the matrix: for each distro, the base image
pinned by digest and the release of each bridge and middleware package. apt
cannot install an old release (packages.ros.org keeps only the current build
of each package), so the image installs what the index carries and
`check-bridge-versions.sh` then fails the build if any release differs from
the lock. It compares the release only, upstream version plus Debian
revision (`3.6.0-1`), and ignores the buildfarm's build stamp after it
(`3.6.0-1noble.20260929.221626`), which changes whenever the farm rebuilds
the same release.

So when upstream ships a new bridge release, that distro's build goes red
until the lock is updated. The weekly CI run is there to catch it on its own
day. Updating the lock is a reviewable change that says what moved, and a
new bridge release is a reason to re-check the known per-version
differences.

The Foxglove SDK is pinned by exact version (`foxglove-sdk==0.27.0`),
installed into a venv because Ubuntu's system Python is externally managed
from 24.04 on. Bumping it is a deliberate, reviewable PR too, never a
floating tag.
If `import ujson` ever stops working inside the container, the suite fails
loudly rather than silently shrinking its coverage.
