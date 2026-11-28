/**
 * Message definitions for the golden-vector types, as ROS 2 `.msg` text.
 *
 * Written by hand from the upstream interface packages, not captured from a
 * robot: the golden test decodes ROS 2's bytes with these, not with
 * definitions the robot reports, so it proves that a definition the library
 * ships decodes what each distro sends. `tests/cdrGolden.test.ts` checks each
 * one against the field list ROS 2 itself reports on every distro (recorded
 * in the fixture beside this file), so a field missed or mistyped here fails
 * there rather than passing by agreeing with itself.
 *
 * Constants are left out: they never reach the wire.
 */

const SEP = '\n================================================================================\n';

const TIME = 'MSG: builtin_interfaces/Time\nint32 sec\nuint32 nanosec';
const HEADER = `MSG: std_msgs/Header\nbuiltin_interfaces/Time stamp\nstring frame_id${SEP}${TIME}`;
const VECTOR3 = 'MSG: geometry_msgs/Vector3\nfloat64 x\nfloat64 y\nfloat64 z';
const QUATERNION =
  'MSG: geometry_msgs/Quaternion\nfloat64 x 0\nfloat64 y 0\nfloat64 z 0\nfloat64 w 1';

const RANGE_FIELDS = [
  'std_msgs/Header header',
  'uint8 radiation_type',
  'float32 field_of_view',
  'float32 min_range',
  'float32 max_range',
  'float32 range',
];

/** Definition text per type, keyed by the vector's type name. */
export const GOLDEN_DEFINITIONS: Record<string, string> = {
  'std_msgs/msg/String': 'string data',
  'std_msgs/msg/Empty': '',
  'std_msgs/msg/Header': `builtin_interfaces/Time stamp\nstring frame_id${SEP}${TIME}`,
  'geometry_msgs/msg/Twist': `geometry_msgs/Vector3 linear\ngeometry_msgs/Vector3 angular${SEP}${VECTOR3}`,
  'sensor_msgs/msg/LaserScan': [
    [
      'std_msgs/Header header',
      'float32 angle_min',
      'float32 angle_max',
      'float32 angle_increment',
      'float32 time_increment',
      'float32 scan_time',
      'float32 range_min',
      'float32 range_max',
      'float32[] ranges',
      'float32[] intensities',
    ].join('\n'),
    HEADER,
  ].join(SEP),
  'tf2_msgs/msg/TFMessage': [
    'geometry_msgs/TransformStamped[] transforms',
    'MSG: geometry_msgs/TransformStamped\nstd_msgs/Header header\nstring child_frame_id\ngeometry_msgs/Transform transform',
    HEADER,
    'MSG: geometry_msgs/Transform\ngeometry_msgs/Vector3 translation\ngeometry_msgs/Quaternion rotation',
    VECTOR3,
    QUATERNION,
  ].join(SEP),
  'sensor_msgs/msg/Range': [[...RANGE_FIELDS, 'float32 variance'].join('\n'), HEADER].join(SEP),
  'sensor_msgs/msg/NavSatFix': [
    [
      'std_msgs/Header header',
      'sensor_msgs/NavSatStatus status',
      'float64 latitude',
      'float64 longitude',
      'float64 altitude',
      'float64[9] position_covariance',
      'uint8 position_covariance_type',
    ].join('\n'),
    HEADER,
    'MSG: sensor_msgs/NavSatStatus\nint8 status\nuint16 service',
  ].join(SEP),
};

/**
 * `sensor_msgs/Range` as Humble has it: no `variance`, which later distros
 * added at the end. The only layout among these types that differs by distro.
 */
export const RANGE_HUMBLE = [RANGE_FIELDS.join('\n'), HEADER].join(SEP);
