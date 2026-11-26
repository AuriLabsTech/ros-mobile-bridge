import { describe, expect, inject, it } from 'vitest';
import { RMW } from './helpers/fixture';
import { zenohInitAckAttempt } from './helpers/readiness';

/**
 * Native Zenoh against the fixture's own `rmw_zenohd`, over the router's
 * `ws/` listener on 7448. Only under `RMB_RMW=rmw_zenoh_cpp`: under the DDS
 * middlewares there is no router, and this file reports as skipped.
 *
 * For now one smoke test: the global `WebSocket` path the library's Zenoh
 * client will use (plain `ws` under Node < 22, unshimmed, see
 * `helpers/ws-global.ts`) reaches the router and completes InitSyn to
 * InitAck in protocol version 9. The Zenoh client's own tests go here once
 * it exists, against the same `/chatter`, `/fixture/empty` and
 * `/fixture/slow` the other two transports test against. The fixture runs
 * ROS domain 17, so every data key starts with `17/` and every liveliness
 * token with `@ros2_lv/17/`.
 */
describe.runIf(RMW === 'rmw_zenoh_cpp')('Zenoh router over WebSocket', () => {
  it('answers an InitSyn with an InitAck in protocol version 9', async () => {
    const url = inject('zenohUrl');
    expect(url).toBeDefined();
    const result = await zenohInitAckAttempt(url!);
    expect(result).toEqual({ ok: true, detail: 'ready' });
  });
});
