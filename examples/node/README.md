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

## Dispatching an action goal

`src/action-goal.mjs` shows the action path: dispatching a goal, waiting for the server's decision to execute it, and reading the terminal outcome. It needs a real robot, so it is not part of the CI smoke run.

```bash
FOXGLOVE_HOST=robot.local FOXGLOVE_PORT=8765 \
ACTION=/dock ACTION_TYPE=nav2_msgs/action/DockRobot \
node src/action-goal.mjs
```

Two things it demonstrates that are easy to get wrong. The goal payload carries the goal type's own fields and nothing else: no wrapper member and no goal id, since the library invents the id and encodes the payload from the schema the bridge advertised. And `handle.acceptance`, the server's decision to take the goal on, resolves on evidence rather than on a clock and never rejects, so a bounded wait is a race against a timer you own.

On Foxglove WebSocket the action's internals are hidden services. The bridge has to be launched with `include_hidden:=true`, or dispatch fails immediately with reason `'unavailable'`.

## What this isn't

This is the smallest possible smoke test. It is not a feature tour. See the top-level [README](../../README.md) and [`ROADMAP.md`](../../ROADMAP.md) for the full public API and the roadmap of additional examples (`examples/browser/`, `examples/react-native/`) planned for the `v0.1.x` series.
