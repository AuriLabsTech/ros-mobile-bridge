# CDR golden vectors

One file per ROS 2 distro, `<distro>.json`, each holding CDR payloads that ROS 2's own
serializer (`rclpy.serialization.serialize_message`) wrote with `RMW_IMPLEMENTATION=rmw_zenoh_cpp`,
inside the integration image for that distro. `tests/cdrGolden.test.ts` decodes every payload
through the library's CDR codec with the definitions in `definitions.ts`, never with ones the
robot reports, and re-encodes the values.

Each file records the distro, the RMW and the Debian versions of the packages involved. Each
vector records the type, the values read back from the built message, the field list rosidl
reports for every type it involves (the test checks `definitions.ts` against it), and the bytes
as hex.

## Regenerating

From the library root, with the integration images built (`tests/integration/docker/build.sh
<distro>`):

```bash
for d in humble jazzy kilted lyrical rolling; do
  docker run --rm --entrypoint bash -e RMW_IMPLEMENTATION=rmw_zenoh_cpp \
    -v "$PWD/tests/fixtures/cdr-golden:/golden" "rmb-integration-bridge:$d" \
    -c 'source /opt/ros/$ROS_DISTRO/setup.bash && python3 /golden/generate.py /golden'
done
```

## What the bytes show

- **Padding is not zero.** ROS 2 leaves the padding between fields uninitialised, so it holds
  whatever was in memory and differs between runs. A regenerated file differs from the committed
  one in those bytes only. The test accepts a differing byte only where no decoded value changes
  when the byte does.
- **The end may be padded.** `std_msgs/Empty` is 8 bytes on Humble, Jazzy, Kilted and Lyrical
  and 5 on Rolling (the header plus one placeholder byte). The codec writes 5.
- **`sensor_msgs/Range` differs by distro.** Humble's has no `variance`, so its payload is 44
  bytes against 48. The Humble vector decodes only with the Humble definition.
- **The script matches the wire.** Its `std_msgs/String` "integration" payload on Jazzy is the
  same bytes as the `/chatter` samples in `../zenoh/chatter.json`, a live session against the
  fixture's router.
