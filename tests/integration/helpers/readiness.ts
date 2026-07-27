/**
 * Protocol-level readiness checks for the two bridges.
 *
 * TCP-accept is a weak readiness signal: both bridges accept sockets before
 * their ROS side is functional. Ready means the protocol actually works:
 * rosbridge answers /rosapi/topics AND delivers live publishes; foxglove
 * negotiates its subprotocol, sends serverInfo, AND delivers binary message
 * data. Deliberately implemented on raw WebSocket, not on the library under
 * test, so fixture health is never certified by the code being tested.
 */

const ATTEMPT_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 1_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type AttemptResult = { ok: boolean; detail: string };

async function withDeadline(
  name: string,
  deadlineMs: number,
  attempt: () => Promise<AttemptResult>,
): Promise<void> {
  const t0 = Date.now();
  let last: AttemptResult = { ok: false, detail: 'no attempt completed' };
  while (Date.now() - t0 < deadlineMs) {
    try {
      last = await attempt();
    } catch (err) {
      last = { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
    if (last.ok) return;
    await sleep(RETRY_DELAY_MS);
  }
  throw new Error(`${name} not ready after ${deadlineMs} ms: ${last.detail}`);
}

/** Ready when /rosapi/topics answers and `watchTopic` delivers 2+ live publishes. */
export async function waitForRosbridge(
  url: string,
  watchTopic: string,
  deadlineMs = 120_000,
): Promise<void> {
  await withDeadline('rosbridge', deadlineMs, () => rosbridgeAttempt(url, watchTopic));
}

function rosbridgeAttempt(url: string, watchTopic: string): Promise<AttemptResult> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    let gotTopics = false;
    let published = 0;
    let settled = false;

    const finish = (ok: boolean, detail: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      resolve({ ok, detail });
    };

    const timer = setTimeout(
      () =>
        finish(
          false,
          `timed out (topics response: ${gotTopics}, ${watchTopic} publishes: ${published})`,
        ),
      ATTEMPT_TIMEOUT_MS,
    );

    ws.onopen = () => {
      ws.send(JSON.stringify({ op: 'call_service', service: '/rosapi/topics', id: 'ready' }));
      ws.send(JSON.stringify({ op: 'subscribe', topic: watchTopic }));
    };
    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      const frame = JSON.parse(event.data) as { op?: string; id?: string; topic?: string };
      if (frame.op === 'service_response' && frame.id === 'ready') gotTopics = true;
      if (frame.op === 'publish' && frame.topic === watchTopic) published += 1;
      if (gotTopics && published >= 2) {
        ws.send(JSON.stringify({ op: 'unsubscribe', topic: watchTopic }));
        finish(true, 'ready');
      }
    };
    ws.onerror = () => finish(false, 'socket error');
    ws.onclose = () => finish(false, 'socket closed before ready');
  });
}

/**
 * Ready when the `foxglove.sdk.v1` subprotocol is negotiated (current
 * foxglove_bridge accepts only that one), serverInfo arrives, and the watch
 * topic's channel delivers at least one binary MessageData frame.
 */
export async function waitForFoxglove(
  url: string,
  watchTopic: string,
  deadlineMs = 120_000,
): Promise<void> {
  await withDeadline('foxglove_bridge', deadlineMs, () => foxgloveAttempt(url, watchTopic));
}

function foxgloveAttempt(url: string, watchTopic: string): Promise<AttemptResult> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, ['foxglove.sdk.v1']);
    ws.binaryType = 'arraybuffer';
    const SUB_ID = 1;
    let gotServerInfo = false;
    let subscribed = false;
    let delivered = 0;
    let settled = false;

    const finish = (ok: boolean, detail: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      resolve({ ok, detail });
    };

    const timer = setTimeout(
      () =>
        finish(
          false,
          `timed out (serverInfo: ${gotServerInfo}, subscribed: ${subscribed}, delivered: ${delivered})`,
        ),
      ATTEMPT_TIMEOUT_MS,
    );

    ws.onopen = () => {
      if (ws.protocol !== 'foxglove.sdk.v1') {
        finish(false, `unexpected subprotocol "${ws.protocol}"`);
      }
    };
    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        const frame = JSON.parse(event.data) as {
          op?: string;
          channels?: Array<{ id: number; topic: string }>;
        };
        if (frame.op === 'serverInfo') gotServerInfo = true;
        if (frame.op === 'advertise' && !subscribed) {
          const channel = frame.channels?.find((c) => c.topic === watchTopic);
          if (channel) {
            subscribed = true;
            ws.send(
              JSON.stringify({
                op: 'subscribe',
                subscriptions: [{ id: SUB_ID, channelId: channel.id }],
              }),
            );
          }
        }
        return;
      }
      // Binary MessageData: opcode 0x01, then subscription id as u32 LE.
      const view = new DataView(event.data as ArrayBuffer);
      if (view.byteLength >= 5 && view.getUint8(0) === 0x01 && view.getUint32(1, true) === SUB_ID) {
        delivered += 1;
        if (gotServerInfo) finish(true, 'ready');
      }
    };
    ws.onerror = () => finish(false, 'socket error');
    ws.onclose = () => finish(false, 'socket closed before ready');
  });
}
