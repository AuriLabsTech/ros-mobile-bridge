/**
 * Installs a WebSocket global when the runtime lacks one (Node < 22).
 * The library itself only ever touches `globalThis.WebSocket`; supplying it
 * is the embedder's job, and in these tests the embedder is vitest.
 *
 * Plain `ws` is injected deliberately, with no conformance shim. Under its
 * browser facade a ws socket is still a Node EventEmitter: an 'error' event
 * with zero listeners crashes the process, where a WHATWG WebSocket
 * (browser, React Native, Node 22 undici) just fires an unhandled event.
 * The library guarantees it never leaves the error event unlistened (a
 * no-op handler survives teardown), and this suite guards that guarantee
 * by running against the crash-prone runtime unshimmed.
 */
export async function ensureWebSocket(): Promise<void> {
  if (typeof globalThis.WebSocket !== 'undefined') return;

  const { WebSocket: WsWebSocket } = await import('ws');
  (globalThis as Record<string, unknown>).WebSocket = WsWebSocket;
}
