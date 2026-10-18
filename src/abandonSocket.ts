// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Benjamín Arratia

/**
 * Close a socket the client is done with, whatever state it is in: detach the
 * client's handlers, then close it, and if it was still connecting, keep one
 * handler that closes it again if the server answers after all.
 *
 * On React Native for Android, `close()` before the socket opens does
 * nothing: the native module only registers the socket on open, so the close
 * finds nothing to close, and the open still arrives later. Without the
 * handler that socket stays open, with no handlers, until the app is killed.
 * The state is read before `close()`, since that close leaves the socket
 * `CLOSING` while it is in fact still connecting. On runtimes where the early
 * `close()` works, the open never comes and the handler never runs.
 *
 * `onerror` keeps a no-op listener instead of null: the `ws` npm package is an
 * EventEmitter, `close()` during CONNECTING emits 'error', and an unlistened
 * EventEmitter 'error' crashes the host process.
 */
export function abandonSocket(ws: WebSocket): void {
  const connecting = ws.readyState === WebSocket.CONNECTING;
  ws.onopen = connecting
    ? () => {
        ws.onopen = null;
        try {
          ws.close();
        } catch {
          // Thrown inside an event handler, nothing could catch it.
        }
      }
    : null;
  ws.onmessage = null;
  ws.onerror = () => {};
  ws.onclose = null;
  if (connecting || ws.readyState === WebSocket.OPEN) {
    try {
      ws.close();
    } catch {
      // A close that throws leaves nothing more to do.
    }
  }
}
