# Roadmap

`ros-mobile-bridge` follows a milestone-based roadmap. Each milestone targets a concrete release. Versions are not date-bound; they ship when the criteria for the milestone are met.

The library reached `v0.1.0` with two production-ready transports (Foxglove WebSocket v1 and rosbridge v2) extracted from a real mobile application's protocol layer. The next two milestones expand the transport set, harden the library against real-world parse-side attacks, and grow the community of consumers.

## v0.1.x — Stabilization (current)

The `v0.1.x` series consolidates the first public release. Patch releases address bug fixes reported by early consumers, documentation improvements, and the integration-test infrastructure that was deferred from the initial cut.

**In scope:**

- Bug fixes against real bridges (`foxglove_bridge`, `rosbridge_server`) reported by consumers.
- Integration tests under `tests/integration/` running pinned versions of both bridges inside Docker Compose.
- Documentation polish, additional examples (`examples/browser/`, `examples/react-native/` wired into CI).
- A follow-up refactor consolidating the structural overlap between the two transport clients into shared internal helpers (control-priority outbox, reconnect scheduler, listener-set fan-out, pending-service-call registry, breaker side-effect wiring). The two clients implement different wire protocols but share these support mechanisms; extracting them reduces the maintenance surface without changing the public API.

**Out of scope:** any breaking API change, any new transport.

## v0.2.0 — Zenoh transport

The `ZenohClient` skeleton already exists in `src/ZenohClient.ts` as roadmap-as-code. `v0.2.0` lands the real implementation.

**Deliverables:**

- Full `ZenohClient` implementation conforming to `IProtocolClient`, using `@eclipse-zenoh/zenoh-ts` as the transport dependency.
- ROS 2 topic name to Zenoh key-expression mapping following the `rmw_zenoh` convention.
- CDR decoding integrated for ROS 2 message payloads carried over Zenoh.
- `ZenohClient` exported from `index.ts`; `ProtocolManager.connect` no longer throws for `protocol: 'zenoh'`.
- Integration tests against a real `rmw_zenoh` setup (`zenohd` + `zenoh-plugin-remote-api` + a ROS 2 node) in CI.
- Documentation: a dedicated section in the README describing when Zenoh is the right transport choice versus the existing two, and a runnable example under `examples/zenoh/`.

**Why this matters:** Zenoh is the recommended middleware for the next generation of ROS 2 deployments (it underlies `rmw_zenoh`, which the OSRF has positioned as a serious alternative to the default DDS-based middleware). No existing JavaScript or TypeScript library provides a ROS 2 client over Zenoh that works in mobile and web runtimes. `v0.2.0` closes that gap.

## v0.3.0 — Hardening and community

`v0.3.0` is the security-and-community milestone. It assumes the library has been in use for several months across multiple consumers and that real-world inputs have surfaced edge cases the test suite did not anticipate.

**Deliverables:**

- A third-party security audit focused on parse-side hardening: malformed Foxglove WebSocket frames, malformed rosbridge JSON envelopes, malformed CDR payloads, oversized messages, prototype-pollution paths, and denial-of-service resistance under adversarial input. Findings addressed and documented in the `CHANGELOG.md`.
- A fuzz-testing harness in CI (`@fast-check/vitest` or equivalent) covering the parser entry points of all three transports.
- Public migration notes if any breaking API change is needed as a consequence of the audit; otherwise no breaking changes.
- Community onboarding work: contributor guide expansion, "good first issue" labels, response-time commitments documented in `CONTRIBUTING.md`, monthly maintainer triage cadence.
- A discoverable presence in the ROS 2 ecosystem: ROS Discourse announcement, link from `index.ros.org` if accepted, listing in `awesome-ros2`.

**Why this matters:** the library will by then be a parser of arbitrary input from untrusted bridges. Security-grade quality is what distinguishes a library a serious robotics company will adopt from a hobby project.

## v0.4.0 (provisional) — agent-driven introspection surface

Hobbyist and academic ROS 2 users increasingly drive their workflow through AI coding agents (Claude Code, Cursor, Codex, OpenCode). A natural extension is agent-driven configuration of mobile dashboards: the agent already knows the robot's topic graph because it just wrote the nodes, so it can wire widget configurations headlessly and hand the user a ready-to-use dashboard. Prior art in adjacent ecosystems (Marimo's `marimo-pair` skill for collaborative notebook editing, shipped via the cross-tool `skills` package manager) validates the pattern shape.

This milestone does **not** build an MCP server inside `ros-mobile-bridge`. Hosting an MCP server requires a runtime-specific transport (stdio on Node, HTTP on browsers / Electron) and would break the four-runtimes-from-one-build promise. Instead, the library exposes the introspection surface an MCP server would need; integrators (mobile apps, CLI tools, agent harnesses) build the transport layer themselves. The command-dispatch safety boundary lives in the integrator that owns the robot connection, not in the library.

**Deliverables:**

- `getAvailableParameters(): Promise<ParameterInfo[]>` and `getParameter(name)` on `IProtocolClient`, mapped through both Foxglove WebSocket and rosbridge wire protocols. Today the library exposes topic and service introspection but has no concept of ROS parameters; agents driving dashboard configuration may want them for parameter-display widgets.
- `getSchemaDefinition(schemaName)` returning the parsed message definition (full type information per field), complementing the existing zero-value `getSchemaTemplate`. Returns `null` for transports that do not carry schemas inline (rosbridge), matching `getSchemaTemplate`'s rosbridge fallback shape.
- Documentation: a dedicated guide page covering "building an MCP server on top of `ros-mobile-bridge`" — the introspection-only contract, the command-dispatch safety boundary (which lives in the consumer, not the library), and worked examples for stdio and HTTP transports.
- A reference adapter under `examples/agent-mcp/` showing how to wrap the introspection methods as MCP tool definitions, runtime-agnostic, leaving the actual server hosting to the integrator.

**Why this matters:** open-source plus AI-agent accessibility for non-experts is what distinguishes a serious robotics library from a thin protocol wrapper. No existing JavaScript ROS 2 client surfaces enough metadata for an agent to drive a dashboard end-to-end. `v0.4.0` ships the contract; downstream projects (including Tinca) ship the experiences on top.

## Beyond v1.0

`v1.0.0` is not date-bound. It represents the point at which the public API has stabilized enough that breaking changes become exceptional rather than routine. Reaching `v1.0` requires:

- At least six months of `v0.x` series usage across multiple consumers without API-breaking pressure.
- The security audit from `v0.3.0` completed with no unresolved high-severity findings.
- Documentation site complete: every public symbol with TSDoc, every public concept with a dedicated guide page, every transport with a runnable example.
- Stable performance characteristics documented (throughput per transport, memory footprint, supported message sizes).

Until those criteria are met, the library remains on the `v0.x` series and treats breaking changes as minor-version bumps per the convention documented in the `CHANGELOG.md`.

## Out of scope (permanently or for the foreseeable future)

This roadmap is opinionated about what the library is **not**:

- The library will not become a robotics framework. It will not own state machines, navigation primitives, motion planning, or any robot model.
- The library will not include UI components. Consumers build their own UI.
- The library will not implement bridge servers (e.g., a node that runs on the robot and exposes a WebSocket). Those exist (`foxglove_bridge`, `rosbridge_server`) and are out of this library's scope.
- The library will not auto-discover bridges on a network. Consumers provide the connection URL.
- The library will not implement transport protocols beyond ROS 2 wire formats. MQTT, Kafka, gRPC, plain HTTP are out of scope.

Out-of-scope items can become in-scope through a written proposal in `GitHub Discussions` and a substantive case for why they belong in this library rather than as a separate package or in the consumer code. The default answer is "no."
