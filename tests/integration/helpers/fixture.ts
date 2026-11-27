/**
 * Docker Compose control for the integration fixture.
 *
 * One container (`bridge`) runs rosbridge_server, foxglove_bridge, and a
 * steady `/chatter` publisher on a ROS 2 image built from
 * `docker/bridge-versions.lock` (pinned, except Rolling). Host ports are
 * ephemeral; tests resolve the mapping through `mappedPort` at startup.
 *
 * `RMB_ROS_DISTRO` picks the distro (default `jazzy`, any distro in
 * `docker/bridge-versions.lock`) and `RMB_RMW` the middleware under the ROS
 * graph (default `rmw_fastrtps_cpp`). Each combination gets its own compose
 * project, so two can run side by side.
 */
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { CONTAINER_LOG_DIR, describeExecError } from './diagnostics';

const execFileP = promisify(execFile);

const COMPOSE_FILE = fileURLToPath(new URL('../docker/compose.yaml', import.meta.url));
const BUILD_SCRIPT = fileURLToPath(new URL('../docker/build.sh', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** How long `docker info` may take before the suite gives up on the daemon. */
const DOCKER_INFO_TIMEOUT_MS = 60_000;

const RMWS = ['rmw_fastrtps_cpp', 'rmw_cyclonedds_cpp', 'rmw_zenoh_cpp'];

export const ROS_DISTRO = process.env.RMB_ROS_DISTRO || 'jazzy';
/**
 * Checked when the fixture starts (`composeUp`), not when this file loads:
 * the unit suite imports this file for its pure helpers, and a stale
 * `RMB_RMW` in a shell must not fail `npm test`.
 */
export const RMW = process.env.RMB_RMW || 'rmw_fastrtps_cpp';

const PROJECT = `rmb-integration-${ROS_DISTRO}-${RMW.replace(/_/g, '-')}`;
const COMPOSE_ENV = { ...process.env, RMB_ROS_DISTRO: ROS_DISTRO, RMB_RMW: RMW };

const ROS_SETUP = 'source "/opt/ros/$ROS_DISTRO/setup.bash"';

async function compose(args: string[], timeoutMs = 60_000): Promise<string> {
  const { stdout } = await execFileP(
    'docker',
    ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, ...args],
    { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: COMPOSE_ENV },
  );
  return stdout;
}

/**
 * Fails the suite when no Docker daemon answers, and returns how long
 * `docker info` took. A freshly started CI runner has taken more than 15 s to
 * answer (four times in November 2026), so the limit is 60 s, and the caller
 * logs the time so a slow daemon shows in the log before it becomes a failure.
 */
export async function assertDockerAvailable(): Promise<number> {
  const started = Date.now();
  try {
    await execFileP('docker', ['info'], { timeout: DOCKER_INFO_TIMEOUT_MS });
  } catch (err) {
    const elapsed = Date.now() - started;
    throw new Error(
      `Integration tests require a running Docker daemon; \`docker info\` failed after ${elapsed} ms ` +
        `(limit ${DOCKER_INFO_TIMEOUT_MS} ms): ${describeExecError(err)}. ` +
        'They are opt-in: `npm run test:integration`. The default `npm test` does not need Docker.',
    );
  }
  return Date.now() - started;
}

/**
 * Builds the image for the selected distro (cached after the first run) and
 * starts the fixture. An unknown `RMB_RMW` fails here, before anything
 * builds, and a lock-file mismatch fails here, with the check's output.
 */
export async function composeUp(): Promise<void> {
  if (!RMWS.includes(RMW)) {
    throw new Error(`RMB_RMW must be one of ${RMWS.join(', ')}; got "${RMW}"`);
  }
  try {
    await execFileP('bash', [BUILD_SCRIPT, ROS_DISTRO], {
      timeout: 1_200_000,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    // The message carries a timeout or a missing binary; stderr carries the
    // build's own output, such as a lock mismatch.
    const { message, stderr = '' } = err as { message: string; stderr?: string };
    throw new Error(
      `Building the ${ROS_DISTRO} bridge image failed: ${message.split('\n')[0]}\n${stderr.slice(-4000)}`,
    );
  }
  await compose(['up', '-d'], 120_000);
}

/**
 * Writes every container's output (bridges, rosapi, the Zenoh router, the
 * `/chatter` publisher), with timestamps, to `<CONTAINER_LOG_DIR>/<project>.log`
 * and returns the path. Processes a test starts with `startInBridge` are not
 * in it: `exec -d` output does not reach the container log.
 */
export async function saveContainerLogs(): Promise<string> {
  const dir = join(REPO_ROOT, CONTAINER_LOG_DIR);
  const file = join(dir, `${PROJECT}.log`);
  const logs = await compose(['logs', '--no-color', '--timestamps'], 60_000);
  await mkdir(dir, { recursive: true });
  await writeFile(file, logs);
  return file;
}

/**
 * Saves the container logs (`saveContainerLogs`), then tears the fixture down.
 * A failed log save is reported and never stops the teardown. Set
 * RMB_INTEGRATION_KEEP=1 to leave the fixture running for debugging.
 */
export async function composeDown(): Promise<void> {
  try {
    console.log(`Container logs saved to ${await saveContainerLogs()}`);
  } catch (err) {
    console.warn(`Could not save the container logs: ${describeExecError(err)}`);
  }
  if (process.env.RMB_INTEGRATION_KEEP === '1') return;
  await compose(['down', '-v', '--remove-orphans'], 120_000);
}

/** Resolves the ephemeral host port mapped to a container port. */
export async function mappedPort(containerPort: number): Promise<number> {
  const out = await compose(['port', 'bridge', String(containerPort)]);
  const firstLine = out.split('\n')[0] ?? '';
  const port = Number(firstLine.slice(firstLine.lastIndexOf(':') + 1));
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Could not resolve host port for container port ${containerPort}: "${out}"`);
  }
  return port;
}

/** Runs a shell command inside the bridge container and returns stdout. */
export async function execInBridge(command: string, timeoutMs = 30_000): Promise<string> {
  return compose(['exec', '-T', 'bridge', 'bash', '-c', command], timeoutMs);
}

/**
 * The ujson serializer is part of the regression surface (rosbridge escapes
 * '/' as '\/' only when ujson is importable). If it silently vanished from
 * the image, that entire class of coverage would vanish with it, so its
 * absence fails the suite loudly.
 */
export async function assertUjsonPresent(): Promise<void> {
  try {
    await execInBridge('python3 -c "import ujson"');
  } catch {
    throw new Error(
      'ujson is not importable inside the bridge container; ' +
        'the escaped-slash regression surface would be silently untested. Fix the image.',
    );
  }
}

/**
 * The distro, the middleware and the bridge package versions under test, one
 * `package version` line each. The build already checked the releases
 * against `docker/bridge-versions.lock`; printing the full versions, build
 * stamp included, makes every run say exactly what it tested.
 *
 * Every run also prints the image's Ubuntu release. Under Zenoh it adds the
 * rmw_zenoh packages and the version string compiled into `libzenohc.so`,
 * the Zenoh release the router actually runs. Distros do not share one: on
 * 2026-11-26 Lyrical's router ran zenoh 1.8.0 and the other four 1.10.1,
 * and Jazzy's had moved from 1.8.0 to 1.10.1 within rmw_zenoh 0.2.x. A
 * Zenoh minor counts as supported only once a run against it passes.
 *
 * One exec, so a failed libzenohc lookup cannot lose the package lines: the
 * lookup's own misses print as text, never as an error. dpkg-query's errors
 * go to stdout for the same reason, so a missing package is named in the log
 * instead of vanishing from the list.
 */
export async function bridgeVersions(): Promise<string> {
  const zenoh = RMW === 'rmw_zenoh_cpp';
  const packages = [
    'foxglove-bridge',
    'rosbridge-server',
    'rosapi',
    ...(zenoh ? ['rmw-zenoh-cpp', 'zenoh-cpp-vendor'] : []),
  ]
    .map((p) => `"ros-$ROS_DISTRO-${p}"`)
    .join(' ');
  const zenohc = zenoh
    ? "; lib=$(find /opt/ros/$ROS_DISTRO -name 'libzenohc.so*' | head -n1); " +
      'v=$(grep -aoE \'v1\\.[0-9]+\\.[0-9]+-[0-9a-f]{40}\' "$lib" | head -n1); ' +
      'echo "libzenohc ${v:-version string not found in ${lib:-no libzenohc.so}}"'
    : '';
  const out = await execInBridge(
    `. /etc/os-release && echo "os $PRETTY_NAME" && dpkg-query -W -f='\${Package} \${Version}\\n' ${packages} 2>&1${zenohc}`,
  );
  return `${ROS_DISTRO}, ${RMW}\n${out.trim()}`;
}

/**
 * Starts a detached `ros2 topic pub` inside the container. Callers use a
 * unique topic per test and stop it via `stopPublisher`. `extraArgs` goes to
 * `ros2 topic pub` as is, for QoS flags such as `--qos-durability`.
 *
 * A count-limited publish (`--times`, `-t`, `--once`, `-1`) must say `-w`:
 * with a count, `ros2 topic pub` defaults to waiting for one subscriber before
 * it publishes, so a message meant to be old when a test subscribes is fresh,
 * and a test about old messages passes whatever the bridge does.
 */
export async function startPublisher(
  topic: string,
  type: string,
  yamlValue: string,
  rateHz = 10,
  extraArgs = '',
): Promise<void> {
  checkPublisherArgs(topic, extraArgs);
  await startInBridge(
    `exec ros2 topic pub -r ${rateHz} ${extraArgs} ${topic} ${type} '${yamlValue}'`,
  );
}

/**
 * Throws when `extraArgs` asks for a count-limited publish without `-w` (see
 * `startPublisher`). Reads each flag the way argparse does: `--times=1`, `-t3`
 * and `-w0` are the same flags as `--times 1`, `-t 3` and `-w 0`, and a long
 * flag may be cut short (`--tim 1`).
 */
export function checkPublisherArgs(topic: string, extraArgs: string): void {
  const flags = extraArgs
    .split(/\s+/)
    .map((a) => (a.startsWith('--') ? a.split('=')[0]! : /^-[tw]\d/.test(a) ? a.slice(0, 2) : a));
  const is = (f: string, short: string, long: string) =>
    f === short || (f.length > 2 && f.startsWith('--') && long.startsWith(f));
  const counted = flags.some((f) => is(f, '-t', '--times') || is(f, '-1', '--once'));
  const waitStated = flags.some((f) => is(f, '-w', '--wait-matching-subscriptions'));
  if (counted && !waitStated) {
    throw new Error(
      `startPublisher(${topic}): a count-limited publish waits for a subscriber unless it states ` +
        '-w (use "-w 0" to publish at once). See the startPublisher TSDoc.',
    );
  }
}

/**
 * Starts a detached command inside the container with ROS sourced, for a
 * long-running process a test stops itself (an echo writing to a file, a
 * publisher `ros2 topic pub` cannot express). Stop it with `stopInBridge`.
 */
export async function startInBridge(command: string): Promise<void> {
  await compose(['exec', '-d', '-T', 'bridge', 'bash', '-c', `${ROS_SETUP} && ${command}`]);
}

/**
 * Stops every process in the container whose command line matches the
 * extended regex `pattern`. Harmless when none is running. The first
 * character goes into a character class (`[t]opic`), so the pattern does not
 * match the command line of the very shell that runs pkill, which would
 * otherwise get itself killed.
 */
export async function stopInBridge(pattern: string): Promise<void> {
  const selfProof = `[${pattern[0]}]${pattern.slice(1)}`;
  await execInBridge(`pkill -f -- "${selfProof}" || true`);
}

/** Stops the publisher started for `topic`. Harmless when none is running. */
export async function stopPublisher(topic: string): Promise<void> {
  await stopInBridge(`topic pub.* ${topic} `);
}
