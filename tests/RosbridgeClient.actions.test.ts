import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RosbridgeClient } from '../src/RosbridgeClient';
import { ActionGoalError } from '../src/errors';
import { installMockWebSocket, type MockWebSocketHandle } from './_helpers/mock-websocket';

describe('RosbridgeClient actions (send_action_goal op family)', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });

  afterEach(() => {
    ws.restore();
  });

  async function connectedClient(): Promise<{
    client: RosbridgeClient;
    socket: ReturnType<MockWebSocketHandle['last']>;
  }> {
    const client = new RosbridgeClient();
    const promise = client.connect('ws://localhost:9090');
    const socket = ws.last();
    socket.simulateOpen();
    await promise;
    return { client, socket };
  }

  it('sendActionGoal sends a send_action_goal op and returns a handle synchronously', async () => {
    const { client, socket } = await connectedClient();

    const handle = client.sendActionGoal(
      '/dock',
      'my_robot_interfaces/action/Dock',
      { target_id: 3 },
    );

    // The handle is usable before any frame comes back.
    expect(typeof handle.cancel).toBe('function');
    expect(handle.outcome).toBeInstanceOf(Promise);

    const frame = socket.sentJson.find((m) => m.op === 'send_action_goal');
    expect(frame).toBeDefined();
    expect(frame).toMatchObject({
      op: 'send_action_goal',
      action: '/dock',
      action_type: 'my_robot_interfaces/action/Dock',
      args: { target_id: 3 },
    });
    expect(typeof frame?.id).toBe('string');
    expect((frame?.id as string).length).toBeGreaterThan(0);
  });

  it('sends the feedback wire flag only when an onFeedback callback is supplied', async () => {
    const { client, socket } = await connectedClient();

    client.sendActionGoal('/dock', 'my_robot_interfaces/action/Dock', {});
    client.sendActionGoal('/undock', 'my_robot_interfaces/action/Undock', {}, {
      onFeedback: () => {},
    });

    const frames = socket.sentJson.filter((m) => m.op === 'send_action_goal');
    expect(frames.length).toBe(2);

    const withoutCallback = frames.find((m) => m.action === '/dock');
    const withCallback = frames.find((m) => m.action === '/undock');

    // No callback: the field is absent entirely, not `false` — the bridge is
    // never asked to relay feedback for a goal nobody is watching.
    expect(withoutCallback && 'feedback' in withoutCallback).toBe(false);
    expect(withCallback?.feedback).toBe(true);
  });

  it('resolves outcome with status and result payload on a terminal action_result', async () => {
    const { client, socket } = await connectedClient();

    const handle = client.sendActionGoal('/dock', 'my_robot_interfaces/action/Dock', {});
    const frame = socket.sentJson.find((m) => m.op === 'send_action_goal');
    const id = frame?.id as string;

    socket.simulateMessage(
      JSON.stringify({
        op: 'action_result',
        id,
        action: '/dock',
        values: { docked: true },
        status: 4,
        result: true,
      }),
    );

    await expect(handle.outcome).resolves.toEqual({
      status: 4,
      result: { docked: true },
    });
  });

  it('rejects outcome with ActionGoalError reason "rejected" when the server declines the goal', async () => {
    const { client, socket } = await connectedClient();

    const handle = client.sendActionGoal('/dock', 'my_robot_interfaces/action/Dock', {});
    const id = socket.sentJson.find((m) => m.op === 'send_action_goal')?.id as string;

    // A rosbridge failure frame: `result: false`, `values` is a bare string.
    socket.simulateMessage(
      JSON.stringify({
        op: 'action_result',
        id,
        action: '/dock',
        values: 'Action goal was rejected',
        status: 5,
        result: false,
      }),
    );

    const err = await handle.outcome.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ActionGoalError);
    expect((err as ActionGoalError).reason).toBe('rejected');
    expect((err as ActionGoalError).detail).toBe('Action goal was rejected');
    expect((err as ActionGoalError).name).toBe('ActionGoalError');
  });

  it('maps "No action server available" to reason "unavailable" and unknown failure text to "server-error"', async () => {
    const { client, socket } = await connectedClient();

    const first = client.sendActionGoal('/dock', 'my_robot_interfaces/action/Dock', {});
    const second = client.sendActionGoal('/dock', 'my_robot_interfaces/action/Dock', {});
    const ids = socket.sentJson
      .filter((m) => m.op === 'send_action_goal')
      .map((m) => m.id as string);

    // The exact no-server text emitted by maintained rosbridge branches after
    // the hardcoded 1.0 s wait_for_server.
    socket.simulateMessage(
      JSON.stringify({
        op: 'action_result',
        id: ids[0],
        action: '/dock',
        values: 'No action server available',
        status: 5,
        result: false,
      }),
    );
    // Any other failure text is unclassifiable: 'server-error', verbatim detail.
    socket.simulateMessage(
      JSON.stringify({
        op: 'action_result',
        id: ids[1],
        action: '/dock',
        values: 'Internal error: something broke',
        status: 5,
        result: false,
      }),
    );

    const firstErr = (await first.outcome.then(() => null, (e: unknown) => e)) as ActionGoalError;
    const secondErr = (await second.outcome.then(() => null, (e: unknown) => e)) as ActionGoalError;

    expect(firstErr.reason).toBe('unavailable');
    expect(firstErr.detail).toBe('No action server available');
    expect(secondErr.reason).toBe('server-error');
    expect(secondErr.detail).toBe('Internal error: something broke');
  });

  it('routes action_feedback frames to the dispatching goal\'s onFeedback callback only', async () => {
    const { client, socket } = await connectedClient();

    const received: Array<Record<string, unknown>> = [];
    client.sendActionGoal(
      '/dock',
      'my_robot_interfaces/action/Dock',
      {},
      { onFeedback: (fb) => received.push(fb) },
    );
    const id = socket.sentJson.find((m) => m.op === 'send_action_goal')?.id as string;

    socket.simulateMessage(
      JSON.stringify({ op: 'action_feedback', id, action: '/dock', values: { progress: 0.25 } }),
    );
    // A frame for an id this client never dispatched must not reach the callback.
    socket.simulateMessage(
      JSON.stringify({
        op: 'action_feedback',
        id: 'someone_elses_goal',
        action: '/dock',
        values: { progress: 0.99 },
      }),
    );
    socket.simulateMessage(
      JSON.stringify({ op: 'action_feedback', id, action: '/dock', values: { progress: 0.5 } }),
    );

    expect(received).toEqual([{ progress: 0.25 }, { progress: 0.5 }]);
  });

  it('cancel() sends cancel_action_goal with the dispatch id, and nothing after the terminal frame', async () => {
    const { client, socket } = await connectedClient();

    const handle = client.sendActionGoal('/dock', 'my_robot_interfaces/action/Dock', {});
    const id = socket.sentJson.find((m) => m.op === 'send_action_goal')?.id as string;

    handle.cancel();

    const cancels = socket.sentJson.filter((m) => m.op === 'cancel_action_goal');
    expect(cancels).toEqual([{ op: 'cancel_action_goal', id, action: '/dock' }]);

    // Terminal arrives (the cancellation was observed to completion)...
    socket.simulateMessage(
      JSON.stringify({
        op: 'action_result',
        id,
        action: '/dock',
        values: {},
        status: 5,
        result: true,
      }),
    );
    await expect(handle.outcome).resolves.toEqual({ status: 5, result: {} });

    // ...after which cancel() is a local no-op: no further frame is sent.
    handle.cancel();
    expect(socket.sentJson.filter((m) => m.op === 'cancel_action_goal').length).toBe(1);
  });

  it('rejects in-flight goals with reason "disconnected" when the connection closes mid-goal', async () => {
    const { client, socket } = await connectedClient();

    const handle = client.sendActionGoal('/dock', 'my_robot_interfaces/action/Dock', {});
    const observed = handle.outcome.then(
      () => null,
      (e: unknown) => e,
    );

    socket.simulateClose();

    const err = (await observed) as ActionGoalError;
    expect(err).toBeInstanceOf(ActionGoalError);
    expect(err.reason).toBe('disconnected');
    // The orphaned-goal case: the robot may still be executing.
    expect(err.message).toContain('may still be executing');
  });

  it('rejects in-flight goals with reason "disconnected" on intentional disconnect()', async () => {
    const { client } = await connectedClient();

    const handle = client.sendActionGoal('/dock', 'my_robot_interfaces/action/Dock', {});
    const observed = handle.outcome.then(
      () => null,
      (e: unknown) => e,
    );

    await client.disconnect();

    const err = (await observed) as ActionGoalError;
    expect(err).toBeInstanceOf(ActionGoalError);
    expect(err.reason).toBe('disconnected');
  });

  it('resolves (not rejects) on ABORTED: an observed lifecycle end is a resolution', async () => {
    const { client, socket } = await connectedClient();

    const handle = client.sendActionGoal('/dock', 'my_robot_interfaces/action/Dock', {});
    const id = socket.sentJson.find((m) => m.op === 'send_action_goal')?.id as string;

    socket.simulateMessage(
      JSON.stringify({
        op: 'action_result',
        id,
        action: '/dock',
        values: { error_code: 7 },
        status: 6,
        result: true,
      }),
    );

    await expect(handle.outcome).resolves.toEqual({
      status: 6,
      result: { error_code: 7 },
    });
  });

  it('a throwing onFeedback callback is contained: later feedback and the terminal still arrive', async () => {
    const { client, socket } = await connectedClient();

    const received: Array<Record<string, unknown>> = [];
    const handle = client.sendActionGoal(
      '/dock',
      'my_robot_interfaces/action/Dock',
      {},
      {
        onFeedback: (fb) => {
          received.push(fb);
          throw new Error('consumer bug');
        },
      },
    );
    const id = socket.sentJson.find((m) => m.op === 'send_action_goal')?.id as string;

    socket.simulateMessage(
      JSON.stringify({ op: 'action_feedback', id, action: '/dock', values: { progress: 0.1 } }),
    );
    socket.simulateMessage(
      JSON.stringify({ op: 'action_feedback', id, action: '/dock', values: { progress: 0.2 } }),
    );
    socket.simulateMessage(
      JSON.stringify({
        op: 'action_result',
        id,
        action: '/dock',
        values: {},
        status: 4,
        result: true,
      }),
    );

    expect(received).toEqual([{ progress: 0.1 }, { progress: 0.2 }]);
    await expect(handle.outcome).resolves.toEqual({ status: 4, result: {} });
  });

  it('throws synchronously when dispatching while not connected', () => {
    const client = new RosbridgeClient();
    // Same message and shape as callService's not-connected failure; a handle
    // returned here would imply a lifecycle that cannot exist.
    expect(() =>
      client.sendActionGoal('/dock', 'my_robot_interfaces/action/Dock', {}),
    ).toThrow('Not connected');
  });
});
