# Security Policy

## Reporting a Vulnerability

If you believe you have found a security vulnerability in `ros-mobile-bridge`, please report it privately. **Do not open a public GitHub issue.**

Email: `security@aurilabs.tech`

Include:

- A description of the issue and its impact.
- Reproduction steps or a proof of concept, if available.
- The affected version(s) of the package.
- Your name and contact details (optional, for credit).

## Process and Timeline

- **Acknowledgement:** within 3 business days of receipt.
- **Triage and assessment:** within 7 business days.
- **Fix or mitigation for confirmed high-severity issues:** within 30 days of confirmation.
- **Coordinated disclosure:** we will work with you on a disclosure timeline. Public disclosure happens after a fix is released, or after 90 days if no fix is feasible. Earlier disclosure is possible by mutual agreement (for example, if a vulnerability is already being exploited in the wild).

A CVE is requested when applicable.

## In Scope

- The published npm artifact and its runtime behavior.
- Parse-side hardening: the library parses arbitrary input from any bridge a consumer points it at, so denial-of-service resistance against malformed Foxglove WebSocket frames, malformed rosbridge JSON envelopes, and oversized payloads is a first-class concern.
- Memory-safety issues (unbounded buffers, prototype pollution, etc.) in the library's own code.

## Out of Scope

- The `examples/` directory: those exist to demonstrate usage and are not part of the published package.
- The test infrastructure (`tests/`, `tests/_helpers/`, `tests/integration/`, `tests/manual/`).
- Third-party bridge software the library connects to (`foxglove_bridge`, `rosbridge_server`, future `zenoh-plugin-remote-api`). Report bridge issues to those projects directly.
- Vulnerabilities in transitive dependencies that do not affect this library's runtime behavior. Report those to the relevant upstream package.
- Misconfigurations in the host application that consumes this library.

## Supported Versions

| Version | Supported |
|--------|-----------|
| 0.1.x  | Yes       |
| < 0.1  | No (pre-release) |

We backport security fixes to the latest minor only. Older minors receive a CVE acknowledgement; consumers should upgrade.
