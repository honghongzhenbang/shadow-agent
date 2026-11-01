import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const PROTOCOL_VERSION = 4;
const DEFAULT_TIMEOUT_MS = 30_000;

export function loadOpenClawGatewaySettings(projectRoot) {
  const configPath = path.join(projectRoot, "runtime", "openclaw-poc", "state", "openclaw.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
  const port = Number(config.gateway?.port ?? 19011);
  const token = config.gateway?.auth?.token;

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid OpenClaw Gateway port in ${configPath}`);
  }
  if (typeof token !== "string" || token.length < 16) {
    throw new Error(`Missing OpenClaw Gateway token in ${configPath}`);
  }

  return {
    url: `ws://127.0.0.1:${port}`,
    token,
    configPath,
  };
}

function messageText(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  return String(data);
}

export function gatewayTransportFailure(event) {
  const codes = new Set();
  const visit = (error, depth = 0) => {
    if (!error || depth > 4) return;
    if (/^[A-Z][A-Z0-9_]{2,40}$/.test(String(error.code ?? ""))) codes.add(error.code);
    visit(error.cause, depth + 1);
    for (const child of (Array.isArray(error.errors) ? error.errors.slice(0, 5) : [])) visit(child, depth + 1);
  };
  visit(event?.error);
  return `OpenClaw Gateway WebSocket error${codes.size ? ` (${[...codes].join(", ")})` : ""}.`;
}

export class OpenClawGatewayClient extends EventEmitter {
  constructor({
    url,
    token,
    autoReconnect = false,
    requestTimeoutMs = DEFAULT_TIMEOUT_MS,
    scopes = ["operator.read", "operator.write"],
  }) {
    super();
    this.url = url;
    this.token = token;
    this.autoReconnect = autoReconnect;
    this.requestTimeoutMs = requestTimeoutMs;
    this.scopes = [...new Set(scopes.map((scope) => String(scope).trim()).filter(Boolean))];
    this.socket = null;
    this.pending = new Map();
    this.connectPromise = null;
    this.connectResolve = null;
    this.connectReject = null;
    this.connectRequestId = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.stopped = true;
    this.connected = false;
    this.lastConnectedAt = null;
    this.lastEventAt = null;
    this.lastError = null;
    this.serverVersion = null;
    this.features = { methods: [], events: [] };
  }

  status() {
    return {
      connected: this.connected,
      url: this.url,
      lastConnectedAt: this.lastConnectedAt,
      lastEventAt: this.lastEventAt,
      lastError: this.lastError,
      serverVersion: this.serverVersion,
      reconnectAttempt: this.reconnectAttempt,
      featureMethodCount: this.features.methods.length,
      featureEventCount: this.features.events.length,
    };
  }

  async start() {
    this.stopped = false;
    try {
      return await this.connect();
    } catch (error) {
      this.#scheduleReconnect();
      throw error;
    }
  }

  async connect() {
    if (this.connected) return this.status();
    if (this.connectPromise) return this.connectPromise;
    if (typeof WebSocket !== "function") throw new Error("This Node runtime does not provide WebSocket.");

    this.stopped = false;
    this.connectPromise = new Promise((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
    });

    const socket = new WebSocket(this.url);
    this.socket = socket;
    const handshakeTimer = setTimeout(() => {
      this.#failConnect(new Error("OpenClaw Gateway handshake timed out."));
      socket.close();
    }, 15_000);

    socket.addEventListener("message", (event) => {
      try {
        this.#handleFrame(JSON.parse(messageText(event.data)), handshakeTimer);
      } catch (error) {
        this.lastError = error.message;
        this.emit("status", this.status());
      }
    });
    socket.addEventListener("error", (event) => {
      this.lastError = gatewayTransportFailure(event);
      this.emit("status", this.status());
    });
    socket.addEventListener("close", () => {
      clearTimeout(handshakeTimer);
      this.connected = false;
      this.socket = null;
      this.connectRequestId = null;
      this.#failConnect(new Error(this.lastError || "OpenClaw Gateway connection closed."));
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("OpenClaw Gateway connection closed."));
      }
      this.pending.clear();
      this.emit("status", this.status());
      this.#scheduleReconnect();
    });

    return this.connectPromise;
  }

  async request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    if (!this.connected || this.socket?.readyState !== WebSocket.OPEN) {
      await this.connect();
    }

    const id = randomUUID();
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`OpenClaw RPC timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
    });
    this.socket.send(JSON.stringify({ type: "req", id, method, params }));
    return result;
  }

  invokeTool(name, args = {}, agentId = "main") {
    return this.request("tools.invoke", { name, args, agentId });
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close(1000, "client stop");
  }

  #handleFrame(frame, handshakeTimer) {
    if (frame.type === "event") {
      this.lastEventAt = new Date().toISOString();
      if (frame.event === "connect.challenge") this.#sendConnect();
      this.emit("event", frame);
      this.emit(frame.event, frame.payload);
      return;
    }

    if (frame.type !== "res") return;
    if (frame.id === this.connectRequestId) {
      clearTimeout(handshakeTimer);
      if (!frame.ok) {
        this.#failConnect(new Error(frame.error?.message || "OpenClaw Gateway rejected the connection."));
        return;
      }
      this.connected = true;
      this.reconnectAttempt = 0;
      this.lastConnectedAt = new Date().toISOString();
      this.lastError = null;
      this.serverVersion = frame.payload?.server?.version ?? null;
      this.features = frame.payload?.features ?? { methods: [], events: [] };
      this.connectRequestId = null;
      const resolve = this.connectResolve;
      this.connectPromise = null;
      this.connectResolve = null;
      this.connectReject = null;
      resolve?.(this.status());
      this.emit("status", this.status());
      return;
    }

    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    clearTimeout(pending.timer);
    if (frame.ok) pending.resolve(frame.payload);
    else {
      const error = new Error(frame.error?.message || `OpenClaw RPC failed: ${pending.method}`);
      error.rpcCode = frame.error?.code ?? null;
      pending.reject(error);
    }
  }

  #sendConnect() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || this.connectRequestId) return;
    this.connectRequestId = randomUUID();
    this.socket.send(JSON.stringify({
      type: "req",
      id: this.connectRequestId,
      method: "connect",
      params: {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: "gateway-client",
          version: "0.1.0",
          platform: "win32",
          mode: "backend",
        },
        role: "operator",
        scopes: this.scopes,
        caps: [],
        commands: [],
        permissions: {},
        auth: { token: this.token },
        locale: "zh-CN",
        userAgent: "shadow-agent-pet/0.1.0",
      },
    }));
  }

  #failConnect(error) {
    if (!this.connectPromise) return;
    const reject = this.connectReject;
    this.connectPromise = null;
    this.connectResolve = null;
    this.connectReject = null;
    this.connectRequestId = null;
    this.lastError = error.message;
    reject?.(error);
  }

  #scheduleReconnect() {
    if (!this.autoReconnect || this.stopped || this.reconnectTimer) return;
    const delayMs = Math.min(10_000, 1_000 * (2 ** this.reconnectAttempt));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => this.#scheduleReconnect());
    }, delayMs);
  }
}

export function workboardCardsFromToolResult(result) {
  return result?.output?.details?.cards ?? [];
}
