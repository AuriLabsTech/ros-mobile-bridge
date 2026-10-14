#!/bin/bash
# Launches both bridges, the Foxglove SDK server, the fixture's service and action servers and a steady traffic topic, then exits (killing the
# container, which is the failure signal) if any of them dies.
#
# RMW_IMPLEMENTATION picks the middleware under the ROS graph:
# rmw_fastrtps_cpp (the default when unset), rmw_cyclonedds_cpp or
# rmw_zenoh_cpp. Zenoh's default setup discovers through a router, which has
# to be up before any node starts.
#
# Deliberately `set -e` without `set -u`: the ROS setup.bash chain reads
# variables that may be unset and would trip nounset.
set -e
source "/opt/ros/$ROS_DISTRO/setup.bash"

if [ "$RMW_IMPLEMENTATION" = "rmw_zenoh_cpp" ]; then
  ros2 run rmw_zenoh_cpp rmw_zenohd &
  # The router listens on TCP 7447. Nodes started before it would fail to
  # discover each other, so wait for the port (bash's /dev/tcp, no netcat).
  router_up=0
  for _ in $(seq 1 300); do
    if (exec 3<>/dev/tcp/127.0.0.1/7447) 2>/dev/null; then
      router_up=1
      break
    fi
    sleep 0.1
  done
  if [ "$router_up" -ne 1 ]; then
    echo "entrypoint: the Zenoh router did not open port 7447 within 30 s" >&2
    exit 1
  fi
fi

# The two *_in_new_thread arguments default to true from Jazzy on and to
# false on Humble. Off, rosbridge works through a connection's ops one at a
# time, so a running action goal holds every later op, its cancel included,
# until the goal ends. Set on every distro so the suite tests the library the
# same way everywhere. tests/integration/README.md has the measurement.
ros2 launch rosbridge_server rosbridge_websocket_launch.xml port:=9090 \
  call_services_in_new_thread:=true send_action_goals_in_new_thread:=true &
ros2 launch foxglove_bridge foxglove_bridge_launch.xml port:=8765 &
/opt/foxglove-sdk/bin/python /sdk_server.py 8766 &

# /fixture/empty and /fixture/slow, which the service and teardown tests call.
python3 /fixture_nodes.py &

# Steady traffic on /chatter: the protocol-level readiness checks and the
# live-topic tests both watch it.
ros2 topic pub -r 10 /chatter std_msgs/msg/String "{data: integration}" &

# If any background job exits, take the container down with it so a dead
# bridge is a visible failure, not a hang.
wait -n
