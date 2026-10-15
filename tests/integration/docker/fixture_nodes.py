"""Service and action servers the integration tests call.

- /fixture/empty (std_srvs/srv/Empty): the shape of a robot's button actions.
  foxglove_bridge answers it with uninitialised padding bytes, which is the
  case the fieldless decode must read as {}.
- /fixture/slow (tf2_msgs/action/LookupTransform, the one action type in the
  base image): each goal runs 10 s unless cancelled. The goal's target_frame
  is its tag; EXEC <tag> and CANCELED <tag> lines go to /tmp/fixture_slow.log
  so a test can see whether a cancel reached the server.
- Topic endpoints, one node per role, so a test knows exactly who is on each
  side: /endpoints_sensor publishes /endpoints/sensor_out and nothing
  subscribes it; /endpoints_listener subscribes /endpoints/cmd_in and nothing
  publishes it; /endpoints_relay publishes and subscribes /endpoints/both.
  Regular (not hidden) nodes, since rosapi does not list hidden ones.
- A service response over rosbridge's max_message_size (10,000,000 on the
  stock launch), which the bridge sends as fragment frames: /fragments_big
  holds 10.5 MB of text in its parameter `blob`, read through
  /fragments_big/get_parameters. (The topic case needs no node here: the
  test publishes through the bridge and subscribes to its own topic.)
"""
import time

import rclpy
from rclpy.action import ActionServer, CancelResponse, GoalResponse
from rclpy.callback_groups import ReentrantCallbackGroup
from rclpy.executors import MultiThreadedExecutor
from std_msgs.msg import Bool, Float32
from std_srvs.srv import Empty
from tf2_msgs.action import LookupTransform

LOG = '/tmp/fixture_slow.log'
# Just over the stock launch's max_message_size, so the bridge cuts it in two.
BIG_CHARS = 10_500_000


def log(line):
    with open(LOG, 'a') as f:
        f.write(f'{time.time():.3f} {line}\n')


def execute(handle):
    tag = handle.request.target_frame
    log(f'EXEC {tag}')
    started = time.time()
    while time.time() - started < 10:
        if handle.is_cancel_requested:
            handle.canceled()
            log(f'CANCELED {tag}')
            return LookupTransform.Result()
        time.sleep(0.02)
    handle.succeed()
    log(f'SUCCEEDED {tag}')
    return LookupTransform.Result()


def main():
    rclpy.init()
    node = rclpy.create_node('fixture_nodes')
    group = ReentrantCallbackGroup()
    node.create_service(Empty, '/fixture/empty', lambda _req, resp: resp, callback_group=group)
    ActionServer(
        node,
        LookupTransform,
        '/fixture/slow',
        execute_callback=execute,
        goal_callback=lambda _goal: GoalResponse.ACCEPT,
        cancel_callback=lambda _req: CancelResponse.ACCEPT,
        callback_group=group,
    )
    sensor = rclpy.create_node('endpoints_sensor')
    sensor_out = sensor.create_publisher(Float32, '/endpoints/sensor_out', 10)
    sensor.create_timer(0.5, lambda: sensor_out.publish(Float32(data=1.0)))

    listener = rclpy.create_node('endpoints_listener')
    listener.create_subscription(Bool, '/endpoints/cmd_in', lambda _msg: None, 10)

    relay = rclpy.create_node('endpoints_relay')
    both = relay.create_publisher(Bool, '/endpoints/both', 10)
    relay.create_subscription(Bool, '/endpoints/both', lambda _msg: None, 10)
    relay.create_timer(0.5, lambda: both.publish(Bool(data=True)))

    big = rclpy.create_node('fragments_big')
    big.declare_parameter('blob', 'x' * BIG_CHARS)

    executor = MultiThreadedExecutor(8)
    for n in (node, sensor, listener, relay, big):
        executor.add_node(n)
    executor.spin()


if __name__ == '__main__':
    main()
