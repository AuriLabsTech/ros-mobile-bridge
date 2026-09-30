# A Foxglove SDK WebSocket server publishing the SDK's own protobuf channels.
#
# Servers built on the Foxglove SDK send its well-known types as protobuf,
# with each channel's schema advertised as a FileDescriptorSet. This is the
# SDK's own server and the SDK's own channel classes, not a hand-rolled
# imitation, so the descriptors and payloads are exactly what such a server
# sends. Values are fixed so the tests can assert them.
import sys
import time

import foxglove
from foxglove.channels import CompressedImageChannel, FrameTransformChannel
from foxglove.messages import (
    CompressedImage,
    FrameTransform,
    Quaternion,
    Timestamp,
    Vector3,
)

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8766
foxglove.start_server(name="rmb-sdk-fixture", host="0.0.0.0", port=port)

image = CompressedImageChannel(topic="/sdk/image")
transform = FrameTransformChannel(topic="/sdk/tf")

while True:
    stamp = Timestamp(sec=1_700_000_000, nsec=250)
    image.log(
        CompressedImage(
            timestamp=stamp,
            frame_id="sdk_camera",
            data=bytes([0xFF, 0xD8, 0xFF, 0xD9]),
            format="jpeg",
        )
    )
    transform.log(
        FrameTransform(
            timestamp=stamp,
            parent_frame_id="world",
            child_frame_id="sdk_camera",
            translation=Vector3(x=1.0, y=2.0, z=3.0),
            rotation=Quaternion(x=0.0, y=0.0, z=0.0, w=1.0),
        )
    )
    time.sleep(0.1)
