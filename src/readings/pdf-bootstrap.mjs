import { syncBuiltinESMExports } from "node:module";
import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import net from "node:net";
import tls from "node:tls";
import dgram from "node:dgram";
import dns from "node:dns";

// This worker only handles our own text/vector tree. Deny remote resources
// before loading dependencies; Node's fs/child/addon permissions are set by the
// parent. This is defense in depth, not a sandbox for arbitrary user code.
const denied = () => { throw new Error("pdf_network_disabled"); };
// Reject asynchronously so Yoga can use its bundled base64 WASM fallback.
globalThis.fetch = async () => denied();
globalThis.WebSocket = class { constructor() { denied(); } };
http.request = http.get = https.request = https.get = denied;
http2.connect = denied;
net.connect = net.createConnection = tls.connect = denied;
net.Socket.prototype.connect = denied;
dgram.createSocket = denied;
dns.lookup = dns.resolve = denied;
syncBuiltinESMExports();
await import("./worker.mjs");
