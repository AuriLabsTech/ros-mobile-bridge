# Advertised-schema fixture corpus

`advertised-schemas.json` holds **verbatim schema strings a real bridge sent**, with the
capture metadata beside them. Nothing in it is written by hand.

## Why it exists

A green test suite is not evidence about the wire. Up to 0.1.11 every action test in this
repo built its own `_SendGoal_Request` schema, and every one of them guessed the same wrong
shape: a nested `goal` member. The suite was green and the encoder was wrong on every real
nav2 action. `docs/ARCHITECTURE.md` already warned about exactly this ("Where a test's bytes
come from"), which is the point: a principle with nothing mechanical behind it works only on
the day it is written.

The corpus is the mechanism. Every encode path round-trips against it in
`tests/advertisedSchemas.roundTrip.test.ts`, so a shape the library invents has to survive a
schema no one here authored.

## Rules

- **Entries are captures.** An entry may only be added from a real `advertiseServices` frame
  (or the equivalent on another transport), pasted unmodified, with its distro, bridge
  library version and capture date recorded.
- **A hand-written schema is not a fixture.** Tests may still write schemas inline to
  exercise a shape no rig produces, and those must be labelled hypothetical where they live.
  They do not belong in this file.
- **Nothing here is trimmed for size.** Comments, blank lines and default values are part of
  what the bridge sends. `nav2_msgs/action/DockRobot_SendGoal` in particular declares
  non-zero defaults (`use_dock_id True`, `max_staging_time 1000.0`), which is what makes it
  the entry that catches a lazy encoder fix: a broken encode writes those defaults rather
  than zeros, and a test asserting "not all zero" passes while broken.

## What this corpus does not establish

Three services, one distro, one bridge library version, one capture. It is evidence that the
rosidl send-goal flattening is real, not that it is universal. `docs/PROTOCOLS.md` states the
same limits where it records the wire fact.
