# Contributing to ros-mobile-bridge

Thanks for your interest. This is a small, intentionally focused library, so please read this guide before opening a PR.

## What this library is — and isn't

`ros-mobile-bridge` is the wire-protocol layer between JavaScript / TypeScript runtimes and ROS 2 robots. It is not a robotics framework, not a UI library, and not a host-application toolkit. The bar for adding to the public API is "a non-trivial fraction of JavaScript consumers of ROS 2 would also want this and would be surprised it's missing." If your use case is specific to one application, wrap the library locally rather than asking us to bend the public surface.

Smaller is better. Options can be added later; they can't be removed without a major version bump.

## Before you open a PR

1. **Discuss first for anything non-trivial.** Open an issue describing the problem and the proposed change. For a new public method or option, include a sketch of the call site and a written rationale. PRs that don't have a corresponding issue or design discussion may sit while we work out the shape.
2. **Look at the existing implementation first.** Several decisions encoded in `IProtocolClient` reflect months of stabilization against real hardware (control-priority outbox, dead-man's switch, breaker state machine, adaptive throttle bucket selection). Understand why something is the way it is before proposing a change to it.
3. **Public API is sacred.** Any rename, removed method, changed signature, narrowed return type, or new required argument is a breaking change. Breaking changes are batched into major version bumps and require migration notes.

## Development setup

```
git clone https://github.com/AuriLabsTech/ros-mobile-bridge.git
cd ros-mobile-bridge
npm install
```

Available scripts:

- `npm run lint` — ESLint
- `npm run typecheck` — TypeScript in `--noEmit` mode
- `npm test` — Vitest unit tests
- `npm run test:watch` — Vitest in watch mode
- `npm run build` — tsup ESM + CJS + `.d.ts`
- `npm run docs` — TypeDoc

## Code style

- TypeScript strict mode, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. No `any` reaches the user. `unknown` only for genuinely opaque payloads.
- No React Native imports, no Expo imports, no Node-only globals (`process`, `Buffer`, `__DEV__`) in `src/`. The ESLint config enforces this; if you need runtime-specific behavior, expose a callback the consumer injects.
- TSDoc on every public type, method, and option. The exported `.d.ts` is the documentation contract.
- Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`, `perf:`). `BREAKING CHANGE:` in the footer triggers a major version bump.

## Tests are not optional

- A new protocol method without a test is incomplete work.
- A bug fix without a regression test is incomplete work.
- The mock WebSocket harness in `tests/_helpers/` exists to make protocol-level tests cheap. If a test is expensive to write, the harness is the thing to improve.
- Integration tests live in `tests/integration/` and run against `foxglove_bridge` / `rosbridge_server` in Docker Compose. They run in CI on push to `main` and on every release tag.

## Adding a runtime dependency

Adding a new runtime dependency requires a paragraph in the PR description answering: what does it do, what does it replace, why is the alternative not viable, and what's the SPDX license identifier. The license must be one of MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, CC0-1.0, or Python-2.0. The CI license check enforces this.

The library targets four runtimes (React Native, browsers, Node.js, Electron) from a single build, so any new dependency must work in all of them. No Node-only packages, no React-Native-only packages.

## Releases

Releases happen from CI on tag push. Developers bump `package.json` version, update `CHANGELOG.md`, commit to `main`, then `git tag vX.Y.Z && git push --tags`. CI runs the full gate (unit + integration + license check + example smoke) before publishing.

## Code of Conduct

Be civil. Disagree with ideas; don't insult people.

## License

By contributing, you agree that your contributions will be licensed under the Apache License 2.0.
