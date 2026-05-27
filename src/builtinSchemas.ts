// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * Bundled IDL definitions for the ROS 2 system services that
 * `foxglove_bridge` (and other CDR transports) commonly discover via graph
 * introspection without shipping inline schemas. Without these fallbacks,
 * callers cannot invoke parameter operations or cancel action goals over
 * Foxglove WS when the bridge omits the IDL — which is the default
 * behavior in `foxglove_bridge` 3.2.6+ for services it discovered through
 * ROS 2 introspection rather than from explicit `.srv` files.
 *
 * Definitions are taken from `rcl_interfaces` and `action_msgs`, both
 * stable across ROS 2 distributions. Bounded sequences (`T[<=N]`) in the
 * canonical `.msg` files are encoded here as unbounded sequences (`T[]`):
 * the two forms produce identical CDR wire output for any value with N or
 * fewer elements, and the parser pin we depend on (`@foxglove/rosmsg`)
 * accepts the unbounded form directly without negotiation.
 *
 * The lookup surface is intentionally narrow:
 * `getBundledServiceSchema(serviceType)` returns request- and
 * response-side schema strings or `null`. This module is **not** exported
 * from `src/index.ts`; it is an internal fallback that the Foxglove
 * protocol client consults only when the bridge-advertised schema is
 * missing. Bridge-shipped schemas remain authoritative when present.
 */

const SEP = '\n================================================================================\n';

// ─── nested message definitions ──────────────────────────────────────────
// Each constant is a single `MSG: package/Type` block. Service schemas
// further down compose them with `SEP` to produce the standard
// concatenated form `@foxglove/rosmsg` parses with `{ ros2: true }`.

const MSG_PARAMETER_VALUE = `MSG: rcl_interfaces/ParameterValue
uint8 type
bool bool_value
int64 integer_value
float64 double_value
string string_value
byte[] byte_array_value
bool[] bool_array_value
int64[] integer_array_value
float64[] double_array_value
string[] string_array_value`;

const MSG_PARAMETER = `MSG: rcl_interfaces/Parameter
string name
ParameterValue value`;

const MSG_SET_PARAMETERS_RESULT = `MSG: rcl_interfaces/SetParametersResult
bool successful
string reason`;

const MSG_LIST_PARAMETERS_RESULT = `MSG: rcl_interfaces/ListParametersResult
string[] names
string[] prefixes`;

const MSG_FLOATING_POINT_RANGE = `MSG: rcl_interfaces/FloatingPointRange
float64 from_value
float64 to_value
float64 step`;

const MSG_INTEGER_RANGE = `MSG: rcl_interfaces/IntegerRange
int64 from_value
int64 to_value
uint64 step`;

const MSG_PARAMETER_DESCRIPTOR = `MSG: rcl_interfaces/ParameterDescriptor
string name
uint8 type
string description
string additional_constraints
bool read_only
bool dynamic_typing
FloatingPointRange[] floating_point_range
IntegerRange[] integer_range`;

const MSG_TIME = `MSG: builtin_interfaces/Time
int32 sec
uint32 nanosec`;

const MSG_UUID = `MSG: unique_identifier_msgs/UUID
uint8[16] uuid`;

const MSG_GOAL_INFO = `MSG: action_msgs/GoalInfo
unique_identifier_msgs/UUID goal_id
builtin_interfaces/Time stamp`;

// ─── service request / response schemas ──────────────────────────────────

// rcl_interfaces/srv/ListParameters
const LIST_PARAMETERS_REQUEST = `uint64 DEPTH_RECURSIVE=0
string[] prefixes
uint64 depth`;
const LIST_PARAMETERS_RESPONSE = ['ListParametersResult result', MSG_LIST_PARAMETERS_RESULT].join(SEP);

// rcl_interfaces/srv/GetParameters
const GET_PARAMETERS_REQUEST = 'string[] names';
const GET_PARAMETERS_RESPONSE = ['ParameterValue[] values', MSG_PARAMETER_VALUE].join(SEP);

// rcl_interfaces/srv/SetParameters
const SET_PARAMETERS_REQUEST = ['Parameter[] parameters', MSG_PARAMETER, MSG_PARAMETER_VALUE].join(SEP);
const SET_PARAMETERS_RESPONSE = ['SetParametersResult[] results', MSG_SET_PARAMETERS_RESULT].join(SEP);

// rcl_interfaces/srv/DescribeParameters
const DESCRIBE_PARAMETERS_REQUEST = 'string[] names';
const DESCRIBE_PARAMETERS_RESPONSE = [
  'ParameterDescriptor[] descriptors',
  MSG_PARAMETER_DESCRIPTOR,
  MSG_FLOATING_POINT_RANGE,
  MSG_INTEGER_RANGE,
].join(SEP);

// rcl_interfaces/srv/GetParameterTypes
const GET_PARAMETER_TYPES_REQUEST = 'string[] names';
const GET_PARAMETER_TYPES_RESPONSE = 'uint8[] types';

// action_msgs/srv/CancelGoal
const CANCEL_GOAL_REQUEST = ['GoalInfo goal_info', MSG_GOAL_INFO, MSG_UUID, MSG_TIME].join(SEP);
const CANCEL_GOAL_RESPONSE = [
  `int8 ERROR_NONE = 0
int8 ERROR_REJECTED = 1
int8 ERROR_UNKNOWN_GOAL_ID = 2
int8 ERROR_GOAL_TERMINATED = 3
int8 return_code
GoalInfo[] goals_canceling`,
  MSG_GOAL_INFO,
  MSG_UUID,
  MSG_TIME,
].join(SEP);

// ─── lookup table ────────────────────────────────────────────────────────

/**
 * Result of {@link getBundledServiceSchema}: the request- and response-side
 * schema strings, ready to feed into `@foxglove/rosmsg`'s `parse` (with
 * `{ ros2: true }`). Both sides are present because every bundled service
 * needs encoding the request and decoding the response — splitting the
 * surface would only invite half-configured callers.
 */
export interface BundledServiceSchemas {
  request: string;
  response: string;
}

const BUNDLED: Record<string, BundledServiceSchemas> = {
  'rcl_interfaces/srv/ListParameters': {
    request: LIST_PARAMETERS_REQUEST,
    response: LIST_PARAMETERS_RESPONSE,
  },
  'rcl_interfaces/srv/GetParameters': {
    request: GET_PARAMETERS_REQUEST,
    response: GET_PARAMETERS_RESPONSE,
  },
  'rcl_interfaces/srv/SetParameters': {
    request: SET_PARAMETERS_REQUEST,
    response: SET_PARAMETERS_RESPONSE,
  },
  'rcl_interfaces/srv/DescribeParameters': {
    request: DESCRIBE_PARAMETERS_REQUEST,
    response: DESCRIBE_PARAMETERS_RESPONSE,
  },
  'rcl_interfaces/srv/GetParameterTypes': {
    request: GET_PARAMETER_TYPES_REQUEST,
    response: GET_PARAMETER_TYPES_RESPONSE,
  },
  'action_msgs/srv/CancelGoal': {
    request: CANCEL_GOAL_REQUEST,
    response: CANCEL_GOAL_RESPONSE,
  },
};

/**
 * Look up bundled request/response schemas for a ROS 2 service type
 * (e.g. `"rcl_interfaces/srv/ListParameters"`). Returns `null` if the type
 * is not in the bundle. Consult this only when the bridge did not ship a
 * schema inline; bridge-advertised schemas remain authoritative.
 */
export function getBundledServiceSchema(serviceType: string): BundledServiceSchemas | null {
  return BUNDLED[serviceType] ?? null;
}

/**
 * Predicate: does the bundle carry a fallback for this service type? Mostly
 * useful for diagnostics — callers needing the schema content itself should
 * call {@link getBundledServiceSchema} directly.
 */
export function hasBundledServiceSchema(serviceType: string): boolean {
  return serviceType in BUNDLED;
}
