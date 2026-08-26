// Dispatching a ROS 2 action goal, and the two questions a caller has about
// it: was the goal taken on, and how did it end.
//
// Requires a live bridge. On Foxglove WebSocket the action's internals are
// hidden services, so the bridge has to run with `include_hidden:=true` or
// dispatch fails fast with reason 'unavailable'.
//
//   FOXGLOVE_HOST=robot.local FOXGLOVE_PORT=8765 \
//   ACTION=/dock ACTION_TYPE=nav2_msgs/action/DockRobot \
//   node src/action-goal.mjs
//
// This file is not part of the CI smoke run: it needs a robot.

import { ProtocolManager, ActionGoalError } from 'ros-mobile-bridge';

const host = process.env.FOXGLOVE_HOST ?? '';
const port = process.env.FOXGLOVE_PORT ? Number(process.env.FOXGLOVE_PORT) : 0;
const action = process.env.ACTION ?? '/dock';
const actionType = process.env.ACTION_TYPE ?? 'nav2_msgs/action/DockRobot';

if (!host || port <= 0) {
  console.log('Set FOXGLOVE_HOST and FOXGLOVE_PORT to run this example against a bridge.');
  process.exit(0);
}

const manager = new ProtocolManager();
const client = await manager.connect({ protocol: 'foxglove-ws', host, port });

// The goal's own fields. `sendActionGoal` encodes them from the schema the
// bridge advertised, so this is the goal type's payload and nothing else: no
// wrapper member, no goal id (the library invents that).
const goal = {
  use_dock_id: true,
  dock_id: process.env.DOCK_ID ?? 'home',
  dock_pose: {
    header: { stamp: { sec: 0, nanosec: 0 }, frame_id: '' },
    pose: {
      position: { x: 0, y: 0, z: 0 },
      orientation: { x: 0, y: 0, z: 0, w: 1 },
    },
  },
  dock_type: '',
  max_staging_time: 120.0,
  navigate_to_staging_pose: true,
};

const handle = client.sendActionGoal(action, actionType, goal, {
  onFeedback: (feedback) => console.log('feedback:', feedback),
});

// `acceptance` says whether the server took the goal on. It resolves on
// evidence and never on a clock, and it never rejects, so it is safe to await
// and safe to ignore. Patience is the caller's decision, so a bounded wait is
// a race against a timer you own. This shape is the same on every transport,
// though the evidence arrives later on rosbridge, where the bridge does not
// relay the accept flag and the first feedback frame is the earliest sign.
const decided = await Promise.race([
  handle.acceptance,
  new Promise((resolve) => setTimeout(() => resolve('no answer yet'), 5_000)),
]);
console.log('acceptance:', decided);

if (decided === 'rejected') {
  // The goal will never run, and `outcome` is already rejecting with reason
  // 'rejected'. Nothing to wait for.
  await handle.outcome.catch(() => {});
  await manager.disconnect();
  process.exit(0);
}

// `outcome` carries the terminal state and the result payload. A canceled or
// aborted goal resolves rather than rejects: the lifecycle was observed to
// its end, and that is an answer. It rejects only when there is no lifecycle
// to report.
try {
  const outcome = await handle.outcome;
  console.log('terminal status:', outcome.status, 'result:', outcome.result);
} catch (err) {
  if (err instanceof ActionGoalError) {
    console.error(`goal has no outcome to report (${err.reason}):`, err.detail);
  } else {
    throw err;
  }
} finally {
  await manager.disconnect();
}
