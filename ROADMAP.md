# Roadmap

`ros-mobile-bridge` follows a milestone-based roadmap. Each milestone targets a concrete release. Versions are not date-bound; they ship when the criteria for the milestone are met.

The library reached `v0.1.0` with two production-ready transports (Foxglove WebSocket v1 and rosbridge v2) extracted from a real mobile application's protocol layer. The roadmap then exposes the robot's ROS 2 graph through a read-only introspection surface, adds a third transport (Zenoh), and finishes with parser-side hardening, community growth, and the v1.0 API freeze.

## v0.1.x — Stabilization (current)

The `v0.1.x` series consolidates the first public release. Patch releases address bug fixes reported by early consumers, documentation improvements, and the integration-test infrastructure that was deferred from the initial cut.

**In scope:**

- Bug fixes against real bridges (`foxglove_bridge`, `rosbridge_server`) reported by consumers.
- Integration tests under `tests/integration/` running pinned versions of both bridges inside Docker Compose.
- Documentation polish, additional examples (`examples/browser/`, `examples/react-native/` wired into CI).
- A follow-up refactor consolidating the structural overlap between the two transport clients into shared internal helpers (control-priority outbox, reconnect scheduler, listener-set fan-out, pending-service-call registry, breaker side-effect wiring). The two clients implement different wire protocols but share these support mechanisms; extracting them reduces the maintenance surface without changing the public API.
- ROS 2 action goal dispatch on `IProtocolClient`: `sendActionGoal` with a minimal goal handle (terminal outcome plus cancel), per-goal feedback, and a per-call `callService` timeout. Actions are the third ROS 2 communication primitive; the library already covers topics and services, and on rosbridge the native `send_action_goal` ops are the only working dispatch path and are unreachable outside the library. Scoped to the lowest common denominator both transports can honestly satisfy; cancel-by-UUID, cancel-all, and action discovery remain reachable through `callService`. Goal acceptance was excluded on that same reasoning and then added in 0.1.12, once it was established that every transport can report it and that the exclusion was sending consumers to hand-written protocol code instead.

**Out of scope:** any new transport. Breaking API changes may ship in 0.1.x when they make the public API more correct: the 0.1 line is where the API's shape gets settled before `v0.2.0` freezes it. Each one opens its `CHANGELOG.md` entry with "Breaking" and a migration note. Additions to `IProtocolClient` are treated as non-breaking: the interface is the contract between the library and its transports, and consumers implementing it themselves (test doubles) should extend a shipped client or implement a partial view.

## v0.2.0 — Programmatic introspection surface

`v0.2.0` exposes a robot's ROS 2 graph to programmatic consumers, including AI coding agents. It lands before the Zenoh transport on purpose: the introspection schema interface must be frozen before a third transport implements against it, and it is the lower-risk milestone that front-loads value.

Hobbyist and academic ROS 2 users increasingly drive their workflow through AI coding agents (Claude Code, Cursor, Codex, OpenCode). A natural extension is agent-driven configuration of mobile dashboards: the agent already knows the robot's topic graph because it just wrote the nodes, so it can wire widget configurations headlessly and hand the user a ready-to-use dashboard. Prior art in an adjacent ecosystem: marimo's `marimo-pair` gives coding agents a notebook through an Agent Skill (a `SKILL.md` the agent reads) plus a marimo CLI command, not an MCP server. Claude Code, Cursor, Codex, VS Code and OpenCode all read Agent Skills today, and MCP itself can now serve them (the Skills Extension, SEP-2640). So this milestone treats MCP and skill-plus-CLI as two ways in, both built on the same introspection surface.

This milestone does **not** build an MCP server inside `ros-mobile-bridge`. Hosting one needs a runtime-specific transport (stdio on Node, an HTTP handler on a server) and would break the four-runtimes-from-one-build promise; the official TypeScript SDK names Node, Bun, Deno and web-standard servers, not React Native. Instead, the library exposes the introspection surface an MCP server would need, and integrators (mobile apps, CLI tools, agent harnesses) host it. A tool definition is plain JSON and needs no transport, so the reference adapter stays runtime-agnostic. The command-dispatch safety boundary lives in the integrator that owns the robot connection, not in the library.

The guide and example target the MCP revision current when they ship (`2026-07-28` as of this writing: stateless, no `initialize` handshake, no sessions, the old HTTP+SSE transport deprecated) and the v2 SDK (`@modelcontextprotocol/server`, Apache-2.0).

**Deliverables:**

- `getAvailableParameters(): Promise<ParameterInfo[]>` and `getParameter(name)` on `IProtocolClient`, mapped through both Foxglove WebSocket and rosbridge wire protocols. Today the library exposes topic and service introspection but has no concept of ROS parameters; agents driving dashboard configuration may want them for parameter-display widgets.
- `getSchemaDefinition(schemaName)` returning the parsed message definition (full type information per field), complementing the existing zero-value `getSchemaTemplate`. One shape on every transport. On rosbridge it reads message types a topic carries from rosapi's raw message text, plus the bundled system services. It never calls rosapi's type-detail services (`/rosapi/message_details` and its siblings), which stop `rosapi_node` on any type with a bounded field on current rosbridge releases.
- Documentation: a dedicated guide page covering "building an MCP server on top of `ros-mobile-bridge`": the introspection-only contract, the command-dispatch safety boundary (which lives in the consumer, not the library), and worked examples for stdio and HTTP. It covers two traps found while mapping definitions to a tool's `inputSchema`: a 64-bit integer above 2^53 sent as a JSON number is rounded before any validator sees it, so 64-bit fields need a stated policy; and a `default` in the schema is never filled in, so a handler completes the message from the definition itself.
- A reference adapter under `examples/agent-mcp/` showing how to wrap the introspection methods as MCP tool definitions, runtime-agnostic, leaving the actual server hosting to the integrator.
- A short note on the skill-plus-CLI route: the same introspection behind a small CLI an agent calls, described by a `SKILL.md`.

**Prior art.** The most used ROS MCP server today is Python ([`robotmcp/ros-mcp-server`](https://github.com/robotmcp/ros-mcp-server)): it reaches the robot over rosbridge and reads field types through rosapi's type-detail services. In JavaScript, `roslib` returns per-field types over rosbridge and `rclnodejs` does on Node with a ROS install.

**Why this matters:** open-source plus AI-agent accessibility for non-experts is what distinguishes a serious robotics library from a thin protocol wrapper. No JavaScript client we found gives per-field types across both rosbridge and Foxglove WebSocket behind one API that runs in browsers and React Native (checked against the GitHub repositories and the npm registry, 2026-10-21). `v0.2.0` ships that contract; downstream projects ship the experiences on top.

## v0.3.0 — Zenoh transport

The `ZenohClient` skeleton already exists in `src/ZenohClient.ts` as roadmap-as-code. `v0.3.0` lands the real implementation, conforming to the `IProtocolClient` interface frozen in `v0.2.0`.

**Deliverables:**

- Full `ZenohClient` implementation conforming to `IProtocolClient`: a native Zenoh session client written in TypeScript over the global `WebSocket`, with no runtime dependency, talking to the robot's existing `rmw_zenohd` router on a `ws/` listener. The robot runs no extra process; enabling the listener is one router setting, documented.
- One build for React Native (Hermes), browsers, Node, and Electron, the same as the other two transports. No WebAssembly and no native module.
- ROS 2 topic and service names mapped to Zenoh key expressions following the `rmw_zenoh` convention, for Humble and for Jazzy and later. The client detects which naming form the robot uses.
- CDR decoding for ROS 2 payloads, with message definitions taken, in order, from the consumer, from bundled definitions for the standard interface packages (checked against the robot's type hashes where it has them), or from the publishing node's type-description service.
- The reliability layer (throttle, outbox, circuit breaker, and their observers) on Zenoh as on the other transports.
- `ZenohClient` exported from `index.ts`; `ProtocolManager.connect` no longer throws for `protocol: 'zenoh'`.
- Integration tests in CI against the released `rmw_zenohd` of each supported ROS 2 distribution.
- Documentation: a dedicated section in the README describing when Zenoh is the right transport choice versus the existing two, how to enable the router's WebSocket listener, how to put a TLS proxy in front of it, and a runnable example under `examples/zenoh/`.

**Known limits, documented rather than hidden:**

- Zenoh's WebSocket link has no TLS today, so encrypted connections (and any web app served over HTTPS) need a TLS-terminating proxy in front of the router.
- The Zenoh router closes a session that receives a WebSocket ping frame. Runtimes do not send these by default, but an Android app that enables pings on React Native's shared HTTP client would drop every Zenoh session.

**Why this matters:** Zenoh is a Tier 1 ROS 2 middleware from Kilted on, through `rmw_zenoh`, and its adoption is growing. `v0.3.0` brings a ROS 2 client over Zenoh to React Native, browsers, Node, and Electron from one build, behind the same interface as the other two transports and with no extra process on the robot.

## v0.4.0 — Hardening, community & v1.0

`v0.4.0` is the security-and-community milestone, and it carries the library into the `v1.0` API freeze. It assumes the library has been in use for several months across multiple consumers and that real-world inputs have surfaced edge cases the test suite did not anticipate.

**Deliverables:**

- A third-party security audit focused on parse-side hardening: malformed Foxglove WebSocket frames, malformed rosbridge JSON envelopes, malformed CDR payloads, oversized messages, prototype-pollution paths, and denial-of-service resistance under adversarial input. Findings addressed and documented in the `CHANGELOG.md`.
- A fuzz-testing harness in CI (`@fast-check/vitest` or equivalent) covering the parser entry points of all three transports.
- Public migration notes if any breaking API change is needed as a consequence of the audit; otherwise no breaking changes.
- Community onboarding work: contributor guide expansion, "good first issue" labels, response-time commitments documented in `CONTRIBUTING.md`, monthly maintainer triage cadence.
- A discoverable presence in the ROS 2 ecosystem: ROS Discourse announcement, link from `index.ros.org` if accepted, listing in `awesome-ros2`.

> Note: individual crash and robustness fixes against malformed input ship as `v0.1.x` bug-fixes whenever a consumer surfaces them (e.g. "don't let one malformed control frame kill the host"). This milestone is the *systematic* pass: the third-party audit, the property-based fuzz harness, and the oversized-message / DoS / prototype-pollution coverage as a whole. The two are complementary, not a contradiction.

**Why this matters:** the library will by then be a parser of arbitrary input from untrusted bridges. Security-grade quality is what distinguishes a library a serious robotics company will adopt from a hobby project.

## Beyond v1.0

`v1.0.0` is not date-bound. It represents the point at which the public API has stabilized enough that breaking changes become exceptional rather than routine. Reaching `v1.0` requires:

- At least six months of `v0.x` series usage across multiple consumers without API-breaking pressure.
- The security audit from `v0.4.0` completed with no unresolved high-severity findings.
- Documentation site complete: every public symbol with TSDoc, every public concept with a dedicated guide page, every transport with a runnable example.
- Stable performance characteristics documented (throughput per transport, memory footprint, supported message sizes).

Until those criteria are met, the library remains on the `v0.x` series. Within 0.1.x, breaking changes ship as patch releases, each marked "Breaking" in the `CHANGELOG.md` with a migration note. From `v0.2.0` on, a breaking change is exceptional and bumps the minor version.

## Out of scope (permanently or for the foreseeable future)

This roadmap is opinionated about what the library is **not**:

- The library will not become a robotics framework. It will not own state machines, navigation primitives, motion planning, or any robot model.
- The library will not include UI components. Consumers build their own UI.
- The library will not implement bridge servers (e.g., a node that runs on the robot and exposes a WebSocket). Those exist (`foxglove_bridge`, `rosbridge_server`) and are out of this library's scope.
- The library will not auto-discover bridges on a network. Consumers provide the connection URL.
- The library will not implement transport protocols beyond ROS 2 wire formats. MQTT, Kafka, gRPC, plain HTTP are out of scope.
- The library will not speak DDS directly. A DDS participant in JavaScript means a native Node add-on (`rclnodejs`) and a ROS 2 install on the same machine, which no phone or browser has. Node consumers who want that can use `rclnodejs` alongside this library.

Out-of-scope items can become in-scope through a written proposal in `GitHub Discussions` and a substantive case for why they belong in this library rather than as a separate package or in the consumer code. The default answer is "no."
