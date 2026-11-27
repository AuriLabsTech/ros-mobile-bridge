/**
 * What the integration fixture leaves behind when a run fails: where the
 * container logs go, and a one-line reason for a failed command. Pure, so the
 * hermetic unit suite tests it without Docker.
 */

/**
 * Where teardown writes the fixture's container logs, relative to the repo
 * root. The CI integration job uploads this folder when it fails
 * (`tests/integrationLogs.ciUpload.test.ts` keeps the two in step). The
 * files are untracked through the repo's `*.log` ignore rule.
 */
export const CONTAINER_LOG_DIR = 'tests/integration/logs';

const MAX_REASON_CHARS = 500;

/**
 * Why a `child_process.execFile` call failed, in one short line. Its first
 * message line is only "Command failed: <command>", so this prefers, in order:
 * a timeout (execFile killed the process), the end of stderr (the command's
 * own reason, such as the Docker daemon not answering), the first message
 * line (a missing binary: "spawn docker ENOENT").
 */
export function describeExecError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const { killed, signal, stderr } = err as Error & {
    killed?: boolean;
    signal?: string | null;
    stderr?: string;
  };
  if (killed) return `timed out (killed with ${signal ?? 'a signal'})`;
  const reason = (stderr ?? '').replace(/\s+/g, ' ').trim();
  if (reason) return reason.slice(-MAX_REASON_CHARS);
  return err.message.split('\n')[0] ?? '';
}
