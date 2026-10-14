"""Service and action servers the integration tests call.

- /fixture/empty (std_srvs/srv/Empty): the shape of a robot's button actions.
  foxglove_bridge answers it with uninitialised padding bytes, which is the
  case the fieldless decode must read as {}.
- /fixture/slow (tf2_msgs/action/LookupTransform, the one action type in the
  base image): each goal runs 10 s unless cancelled. The goal's target_frame
  is its tag; EXEC <tag> and CANCELED <tag> lines go to /tmp/fixture_slow.log
  so a test can see whether a cancel reached the server.
"""
import time

import rclpy
from rclpy.action import ActionServer, CancelResponse, GoalResponse
from rclpy.callback_groups import ReentrantCallbackGroup
from rclpy.executors import MultiThreadedExecutor
from std_srvs.srv import Empty
from tf2_msgs.action import LookupTransform

LOG = '/tmp/fixture_slow.log'


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
    executor = MultiThreadedExecutor(8)
    executor.add_node(node)
    executor.spin()


if __name__ == '__main__':
    main()
