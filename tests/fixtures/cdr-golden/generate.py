"""Write CDR golden vectors for one ROS 2 distro, from ROS 2's own serializer.

Run inside the integration image of that distro, with rmw_zenoh selected so
the bytes come from the same serializer a robot running rmw_zenoh uses:

    docker run --rm --entrypoint bash -e RMW_IMPLEMENTATION=rmw_zenoh_cpp \
      -v "$PWD/tests/fixtures/cdr-golden:/golden" rmb-integration-bridge:<distro> \
      -c 'source /opt/ros/$ROS_DISTRO/setup.bash && python3 /golden/generate.py /golden'

It writes `<distro>.json` into the directory given. The README beside this
script has the loop over every distro.

Each vector holds the type, the values it was built from (read back through
rosidl, not the literals below, so the JSON is what ROS 2 holds), the field
list ROS 2 reports for every type involved, and the serialized bytes as hex.
Every float is exactly representable as float32, so a decoder's result can be
compared for equality. Padding bytes are whatever ROS 2's serializer left in
them, which differs from run to run.
"""

import importlib
import json
import os
import subprocess
import sys

from rclpy.serialization import serialize_message
from rosidl_runtime_py import message_to_ordereddict


def msg(type_name):
    pkg, _, name = type_name.split("/")
    return getattr(importlib.import_module(f"{pkg}.msg"), name)


def build(type_name, values):
    """Build a message, setting only fields the distro's type has."""
    instance = msg(type_name)()
    fields = instance.get_fields_and_field_types()
    for key, value in values.items():
        if key not in fields:
            continue
        current = getattr(instance, key)
        if isinstance(value, dict):
            setattr(instance, key, build_nested(current, value))
        elif isinstance(value, list) and value and isinstance(value[0], dict):
            elem_type = fields[key][len("sequence<") : -1].replace("/", "/msg/")
            setattr(instance, key, [build(elem_type, v) for v in value])
        else:
            setattr(instance, key, value)
    return instance


def build_nested(instance, values):
    fields = instance.get_fields_and_field_types()
    for key, value in values.items():
        if key not in fields:
            continue
        current = getattr(instance, key)
        if isinstance(value, dict):
            setattr(instance, key, build_nested(current, value))
        else:
            setattr(instance, key, value)
    return instance


def field_lists(instance, seen):
    """Every type reachable from this message, mapped to its field list."""
    name = type(instance).__module__.split(".")[0] + "/" + type(instance).__name__
    if name in seen:
        return
    fields = instance.get_fields_and_field_types()
    seen[name] = fields
    for key in fields:
        value = getattr(instance, key)
        if hasattr(value, "get_fields_and_field_types"):
            field_lists(value, seen)
        elif isinstance(value, list) and value and hasattr(value[0], "get_fields_and_field_types"):
            field_lists(value[0], seen)
    if "sequence<" in str(fields.values()):
        # A sequence that was left empty still names a type worth listing.
        for kind in fields.values():
            if kind.startswith("sequence<") and "/" in kind:
                elem = kind[len("sequence<") : -1]
                field_lists(msg(elem.replace("/", "/msg/"))(), seen)


HEADER = {"stamp": {"sec": 1700000000, "nanosec": 123456789}, "frame_id": "base_link"}

VECTORS = [
    # The payload tests/fixtures/zenoh/chatter.json caught on the wire, so the
    # test can compare this script's bytes with a live capture.
    ("std_msgs/msg/String", {"data": "integration"}),
    ("std_msgs/msg/String", {"data": "Hello World: 7"}),
    ("std_msgs/msg/String", {"data": "grüße ✓"}),
    (
        "geometry_msgs/msg/Twist",
        {"linear": {"x": 1.5, "y": -2.25, "z": 0.0}, "angular": {"x": 0.0, "y": 0.0, "z": 0.75}},
    ),
    ("std_msgs/msg/Header", HEADER),
    (
        "sensor_msgs/msg/LaserScan",
        {
            "header": HEADER,
            "angle_min": -1.5,
            "angle_max": 1.5,
            "angle_increment": 0.25,
            "time_increment": 0.0009765625,
            "scan_time": 0.125,
            "range_min": 0.25,
            "range_max": 30.0,
            "ranges": [1.0, 2.5, 0.75],
            "intensities": [100.0, 0.0],
        },
    ),
    (
        "tf2_msgs/msg/TFMessage",
        {
            "transforms": [
                {
                    "header": HEADER,
                    "child_frame_id": "laser",
                    "transform": {
                        "translation": {"x": 0.25, "y": 0.0, "z": 0.5},
                        "rotation": {"x": 0.0, "y": 0.0, "z": 0.5, "w": 0.75},
                    },
                },
                {
                    "header": {"stamp": {"sec": 1, "nanosec": 2}, "frame_id": "odom"},
                    "child_frame_id": "base_link",
                    "transform": {
                        "translation": {"x": -1.0, "y": 2.0, "z": 0.0},
                        "rotation": {"x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0},
                    },
                },
            ]
        },
    ),
    (
        "sensor_msgs/msg/Range",
        {
            "header": HEADER,
            "radiation_type": 1,
            "field_of_view": 0.5,
            "min_range": 0.25,
            "max_range": 4.0,
            "range": 1.5,
            "variance": 0.0625,
        },
    ),
    ("std_msgs/msg/Empty", {}),
    (
        "sensor_msgs/msg/NavSatFix",
        {
            "header": HEADER,
            "status": {"status": -1, "service": 1},
            "latitude": 39.5,
            "longitude": -0.375,
            "altitude": 12.25,
            "position_covariance": [0.5, 0.0, 0.0, 0.0, 0.5, 0.0, 0.0, 0.0, 2.0],
            "position_covariance_type": 2,
        },
    ),
]


def package_version(pkg):
    out = subprocess.run(
        ["dpkg-query", "-W", "-f=${Version}", f"ros-{os.environ['ROS_DISTRO']}-{pkg}"],
        capture_output=True,
        text=True,
    )
    return out.stdout.strip() or None


def main():
    vectors = []
    for type_name, values in VECTORS:
        instance = build(type_name, values)
        types = {}
        field_lists(instance, types)
        vectors.append(
            {
                "type": type_name,
                "values": json.loads(json.dumps(message_to_ordereddict(instance))),
                "fields": types,
                "cdr": serialize_message(instance).hex(),
            }
        )
    packages = [
        "rmw-zenoh-cpp",
        "rclpy",
        "std-msgs",
        "geometry-msgs",
        "sensor-msgs",
        "tf2-msgs",
        "builtin-interfaces",
    ]
    source = {
        "distro": os.environ["ROS_DISTRO"],
        "rmw": os.environ.get("RMW_IMPLEMENTATION"),
        "packages": {p: package_version(p) for p in packages},
        "script": "tests/fixtures/cdr-golden/generate.py",
    }
    out = os.path.join(sys.argv[1], f"{os.environ['ROS_DISTRO']}.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"source": source, "vectors": vectors}, f, indent=2, ensure_ascii=False)
        f.write("\n")


if __name__ == "__main__":
    main()
