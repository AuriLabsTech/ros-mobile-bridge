/**
 * Docker Compose control for the integration fixture.
 *
 * One container (`bridge`) runs rosbridge_server, foxglove_bridge, and a
 * steady `/chatter` publisher on a pinned ROS 2 image. Host ports are
 * ephemeral; tests resolve the mapping through `mappedPort` at startup.
 *
 * `RMB_ROS_DISTRO` picks the distro (default `jazzy`, any distro in
 * `docker/bridge-versions.lock`) and `RMB_RMW` the middleware under the ROS
 * graph (default `rmw_fastrtps_cpp`). Each combination gets its own compose
 * project, so two can run side by side.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);

const COMPOSE_FILE = fileURLToPath(new URL('../docker/compose.yaml', import.meta.url));
const BUILD_SCRIPT = fileURLToPath(new URL('../docker/build.sh', import.meta.url));

const RMWS = ['rmw_fastrtps_cpp', 'rmw_cyclonedds_cpp', 'rmw_zenoh_cpp'];

export const ROS_DISTRO = process.env.RMB_ROS_DISTRO || 'jazzy';
export const RMW = process.env.RMB_RMW || 'rmw_fastrtps_cpp';
if (!RMWS.includes(RMW)) {
  throw new Error(`RMB_RMW must be one of ${RMWS.join(', ')}; got "${RMW}"`);
}

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

export async function assertDockerAvailable(): Promise<void> {
  try {
    await execFileP('docker', ['info'], { timeout: 15_000 });
  } catch {
    throw new Error(
      'Integration tests require a running Docker daemon. ' +
        'They are opt-in: `npm run test:integration`. The default `npm test` does not need Docker.',
    );
  }
}

/**
 * Builds the image for the selected distro (cached after the first run) and
 * starts the fixture. A lock-file mismatch fails here, with the check's output.
 */
export async function composeUp(): Promise<void> {
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

/** Tears the fixture down. Set RMB_INTEGRATION_KEEP=1 to leave it running for debugging. */
export async function composeDown(): Promise<void> {
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
 */
export async function bridgeVersions(): Promise<string> {
  const out = await execInBridge(
    "dpkg-query -W -f='${Package} ${Version}\\n' " +
      '"ros-$ROS_DISTRO-foxglove-bridge" "ros-$ROS_DISTRO-rosbridge-server" "ros-$ROS_DISTRO-rosapi"',
  );
  return `${ROS_DISTRO}, ${RMW}\n${out.trim()}`;
}

/**
 * Starts a detached `ros2 topic pub` inside the container. Callers use a
 * unique topic per test and stop it via `stopPublisher`.
 */
export async function startPublisher(
  topic: string,
  type: string,
  yamlValue: string,
  rateHz = 10,
): Promise<void> {
  await compose([
    'exec',
    '-d',
    '-T',
    'bridge',
    'bash',
    '-c',
    `${ROS_SETUP} && exec ros2 topic pub -r ${rateHz} ${topic} ${type} '${yamlValue}'`,
  ]);
}

/** Stops the publisher started for `topic`. Harmless when none is running. */
export async function stopPublisher(topic: string): Promise<void> {
  // The [/] character class keeps the pattern from matching the command line
  // of the very shell that runs pkill (which would get itself SIGTERMed).
  const selfProofTopic = `[/]${topic.slice(1)}`;
  await execInBridge(`pkill -f -- "topic pub.* ${selfProofTopic} " || true`);
}
