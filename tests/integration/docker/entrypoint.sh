#!/bin/bash
# Launches both bridges plus a steady traffic topic, then exits (killing the
# container, which is the failure signal) if any of them dies.
#
# Deliberately `set -e` without `set -u`: the ROS setup.bash chain reads
# variables that may be unset and would trip nounset.
set -e
source /opt/ros/jazzy/setup.bash

ros2 launch rosbridge_server rosbridge_websocket_launch.xml port:=9090 &
ros2 launch foxglove_bridge foxglove_bridge_launch.xml port:=8765 &

# Steady traffic on /chatter: the protocol-level readiness checks and the
# live-topic tests both watch it.
ros2 topic pub -r 10 /chatter std_msgs/msg/String "{data: integration}" &

# If any background job exits, take the container down with it so a dead
# bridge is a visible failure, not a hang.
wait -n
