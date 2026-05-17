# Node.js example

Minimal demonstration that `ros-mobile-bridge` installs and runs on Node.js. Consumed by the CI `example-smoke` job to verify the published tarball is healthy.

## Requirements

- Node.js 22 or newer (Node 22+ has native `WebSocket`; older versions need a polyfill like `ws`).

## Run

From this directory:

```bash
npm install
node src/index.mjs
```

By default the script imports the library, constructs a `ProtocolManager`, prints the default ports, and exits.

To connect to a running Foxglove WebSocket bridge:

```bash
FOXGLOVE_HOST=robot.local FOXGLOVE_PORT=8765 node src/index.mjs
```

The script will then list the topics the bridge is publishing and disconnect.

## What this isn't

This is the smallest possible smoke test. It is not a feature tour. See the top-level [README](../../README.md) and [`ROADMAP.md`](../../ROADMAP.md) for the full public API and the roadmap of additional examples (`examples/browser/`, `examples/react-native/`) planned for the `v0.1.x` series.
