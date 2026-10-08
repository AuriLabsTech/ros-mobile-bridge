// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * The JSON-op `serviceCallResponse` path, which older bridges use and which
 * carries the response payload as a base64 string.
 *
 * The client decodes that string with its own decoder rather than `atob` or
 * `Buffer` (neither is in the platform floor), so the decoder's edge cases are
 * pinned here through the public `callService`: unpadded input, every padding
 * length, and characters outside the base64 alphabet, which a line-wrapping
 * encoder inserts and which must be skipped rather than read as data. A
 * `json` response is used because one wrong or missing byte makes it
 * unparseable, so any decoding slip shows up as a rejection.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FoxgloveClient } from '../src/FoxgloveClient';
import {
  installMockWebSocket,
  findSentServiceCallRequest,
  type MockWebSocketHandle,
  type MockWebSocket,
} from './_helpers/mock-websocket';

const SERVICE_ID = 11;

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

describe('FoxgloveClient — base64 payloads on the JSON serviceCallResponse op', () => {
  let ws: MockWebSocketHandle;

  beforeEach(() => {
    ws = installMockWebSocket();
  });
  afterEach(() => {
    ws.restore();
  });

  async function connected(): Promise<{ client: FoxgloveClient; socket: MockWebSocket }> {
    const client = new FoxgloveClient();
    const connectPromise = client.connect('ws://localhost:8765');
    const socket = ws.last();
    socket.simulateOpen('foxglove.websocket.v1');
    socket.simulateMessage(JSON.stringify({ op: 'serverInfo', name: 'm', capabilities: [] }));
    socket.simulateMessage(JSON.stringify({ op: 'advertise', channels: [] }));
    socket.simulateMessage(
      JSON.stringify({
        op: 'advertiseServices',
        services: [{ id: SERVICE_ID, name: '/trigger', type: 'std_srvs/srv/Trigger' }],
      }),
    );
    await connectPromise;
    return { client, socket };
  }

  /** Call `/trigger` and answer it on the JSON op with `data` as given. */
  async function respondWith(data: string): Promise<Record<string, unknown>> {
    const { client, socket } = await connected();
    const call = client.callService('/trigger', {});
    const sent = findSentServiceCallRequest(socket);
    if (!sent) throw new Error('client sent no service call request');
    socket.simulateMessage(
      JSON.stringify({
        op: 'serviceCallResponse',
        serviceId: SERVICE_ID,
        callId: sent.callId,
        encoding: 'json',
        data,
      }),
    );
    return call;
  }

  // Byte lengths 9, 10 and 11: no padding, `==`, and `=`.
  it.each([
    ['no padding', { ok: 12 }],
    ['two padding characters', { ok: 123 }],
    ['one padding character', { ok: 1234 }],
  ])('decodes a payload whose base64 has %s', async (_label, response) => {
    const json = JSON.stringify(response);
    const b64 = toBase64(new TextEncoder().encode(json));

    await expect(respondWith(b64)).resolves.toEqual(response);
  });

  it('skips line breaks that a line-wrapping encoder puts inside the base64', async () => {
    const response = { success: true, message: 'docked at station 4' };
    const b64 = toBase64(new TextEncoder().encode(JSON.stringify(response)));
    // MIME-style wrapping, short lines so the payload holds several breaks.
    const wrapped = b64.replace(/(.{8})/g, '$1\r\n');

    await expect(respondWith(wrapped)).resolves.toEqual(response);
  });

  it('skips characters outside the base64 alphabet, including ones above U+00FF', async () => {
    const response = { success: true, message: '' };
    const b64 = toBase64(new TextEncoder().encode(JSON.stringify(response)));
    const lineSeparator = String.fromCharCode(0x2028);
    const noisy = [b64.slice(0, 4), ' \t', b64.slice(4, 12), lineSeparator, b64.slice(12)].join('');

    await expect(respondWith(noisy)).resolves.toEqual(response);
  });
});
