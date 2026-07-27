// Worker-side setup: the library resolves `globalThis.WebSocket` at connect
// time, so every test worker needs the global installed (Node < 22 lacks it).
import { ensureWebSocket } from './helpers/ws-global';

await ensureWebSocket();
