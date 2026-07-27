# Integration tests

Protocol-conformance tests that run the library against real, pinned bridge
servers instead of the `MockWebSocket` harness: `rosbridge_server` and
`foxglove_bridge` from ROS 2 Jazzy, inside one Docker Compose container.

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

Host ports are ephemeral, so the suite can run next to anything else,
including a second copy of itself. Set `RMB_INTEGRATION_KEEP=1` to leave the
container running after a run for debugging; tear it down with
`docker compose -p rmb-integration -f tests/integration/docker/compose.yaml down -v`.

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

## Fixture layout

- `docker/`: the pinned image (Dockerfile, entrypoint, compose file). One
  container runs both bridges plus a steady `/chatter` publisher on a fixed,
  non-default `ROS_DOMAIN_ID`.
- `helpers/fixture.ts`: compose control, in-container publishers, the ujson
  presence assert.
- `helpers/readiness.ts`: protocol-level readiness. TCP-accept is not
  readiness; ready means rosapi answers and live frames flow. Implemented on
  raw WebSocket so fixture health is never certified by the library under
  test.
- `globalSetup.ts`: boots the fixture once per run and injects the resolved
  URLs into the tests.

## Version pinning policy

The base image is pinned by digest and the bridge packages come from the
distro archive that digest resolves. Bumping the pin is a deliberate,
reviewable PR that states what changed in the bridges, never a floating tag.
If `import ujson` ever stops working inside the container, the suite fails
loudly rather than silently shrinking its coverage.
