/** Polls `condition` until it returns true or `timeoutMs` elapses. */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
  label = 'condition',
  intervalMs = 200,
): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label}`);
}
