import { TOOL_NAME, MCP_PROTOCOL_VERSION, SUPPORTED_MCP_PROTOCOL_VERSIONS, MAX_REQUEST_BYTES } from '../config.mjs';
import { TOOL_DEFINITION } from '../action/contracts.mjs';
import { isPlainObject, validateProposedAction } from '../action/metadata.mjs';
import { reviewSensitiveAction } from '../review/service.mjs';

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function sendJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function toolCallResult(review, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(review) }],
    structuredContent: review,
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * Stream JSON-RPC lines without allowing an unterminated line to grow without
 * bound. Bytes beyond the limit are discarded until the next newline.
 * @param {AsyncIterable<Buffer|string>} stream
 * @param {number} [maxBytes]
 * @returns {AsyncGenerator<{line?: Buffer, oversized?: boolean}>}
 */
export async function* readBoundedLines(stream, maxBytes = MAX_REQUEST_BYTES) {
  let pending = Buffer.alloc(0);
  let discarding = false;
  for await (const rawChunk of stream) {
    const data = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(String(rawChunk));
    let offset = 0;
    while (offset < data.length) {
      const newlineIndex = data.indexOf(0x0a, offset);
      const segmentEnd = newlineIndex === -1 ? data.length : newlineIndex;
      const segment = data.subarray(offset, segmentEnd);
      if (discarding) {
        if (newlineIndex === -1) {
          offset = data.length;
          continue;
        }
        discarding = false;
        pending = Buffer.alloc(0);
        offset = newlineIndex + 1;
        yield { oversized: true };
        continue;
      }
      if (pending.length + segment.length > maxBytes) {
        pending = Buffer.alloc(0);
        discarding = newlineIndex === -1;
        if (newlineIndex !== -1) {
          offset = newlineIndex + 1;
          yield { oversized: true };
        } else offset = data.length;
        continue;
      }
      if (segment.length > 0) pending = Buffer.concat([pending, segment]);
      if (newlineIndex === -1) {
        offset = data.length;
        continue;
      }
      const line = pending[pending.length - 1] === 0x0d ? pending.subarray(0, pending.length - 1) : pending;
      pending = Buffer.alloc(0);
      offset = newlineIndex + 1;
      yield { line };
    }
  }
  if (discarding) yield { oversized: true };
  else if (pending.length > 0) yield { line: pending[pending.length - 1] === 0x0d ? pending.subarray(0, pending.length - 1) : pending };
}

function rpcRequestKey(value) {
  if (typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) return `${typeof value}:${value}`;
  return null;
}

async function handleRpc(message, context) {
  if (!isPlainObject(message) || message.jsonrpc !== "2.0") return jsonRpcError(null, -32600, "Invalid JSON-RPC request.");
  const id = message.id;
  if (message.method === "notifications/initialized") return null;
  if (message.method === "initialize") {
    const params = isPlainObject(message.params) ? message.params : {};
    if (context.initialized) return jsonRpcError(id, -32600, "Connection is already initialized.");
    const requestedVersion = params.protocolVersion;
    if (requestedVersion !== undefined && !SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(requestedVersion)) {
      return jsonRpcError(id, -32602, "Unsupported MCP protocol version.");
    }
    context.protocolVersion = requestedVersion ?? MCP_PROTOCOL_VERSION;
    context.initialized = true;
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: context.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "codex-permission-reviewer", version: "0.3.0" },
      },
    };
  }
  if (message.method === "shutdown") {
    context.shutdownRequested = true;
    queueMicrotask(() => context.stop());
    return { jsonrpc: "2.0", id, result: null };
  }
  if (message.method === "notifications/cancelled") {
    const params = isPlainObject(message.params) ? message.params : {};
    const requestKey = rpcRequestKey(params.requestId);
    if (requestKey !== null) context.pendingRequests.get(requestKey)?.abort("reviewer_cancelled");
    return null;
  }
  if (message.method === "tools/list" || message.method === "tools/call") {
    if (!context.initialized) {
      return message.id === undefined ? null : jsonRpcError(id, -32002, "Initialize the MCP connection before using tools.");
    }
  }
  if (message.method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: [TOOL_DEFINITION] } };
  if (message.method === "tools/call") {
    if (id === undefined) return null;
    const params = isPlainObject(message.params) ? message.params : {};
    if (params.name !== TOOL_NAME) return jsonRpcError(id, -32602, "Unknown tool.");
    const requestKey = rpcRequestKey(id);
    if (requestKey === null) return jsonRpcError(id, -32602, "Tool request id must be a string or number.");
    if (context.pendingRequests.has(requestKey)) return jsonRpcError(id, -32600, "A request with this id is already running.");
    const controller = new AbortController();
    context.pendingRequests.set(requestKey, controller);
    let review;
    try {
      review = await reviewSensitiveAction(params.arguments, { signal: controller.signal });
    } finally {
      context.pendingRequests.delete(requestKey);
    }
    const validation = validateProposedAction(params.arguments);
    return { jsonrpc: "2.0", id, result: toolCallResult(review, !validation.ok) };
  }
  if (typeof message.method === "string" && message.id === undefined) return null;
  return jsonRpcError(id, -32601, "Method not found.");
}

function isExpectedInputClose(error) {
  return error?.code === "ERR_STREAM_PREMATURE_CLOSE" || error?.code === "ABORT_ERR" || error?.name === "AbortError";
}

export async function main() {
  const context = {
    protocolVersion: MCP_PROTOCOL_VERSION,
    initialized: false,
    pendingRequests: new Map(),
    activeTasks: new Set(),
    stopping: false,
    shutdownRequested: false,
    stop() {
      if (this.stopping) return;
      this.stopping = true;
      for (const controller of this.pendingRequests.values()) controller.abort("reviewer_cancelled");
      if (!process.stdin.readableEnded) process.stdin.push?.(null);
      process.stdin.pause?.();
    },
  };
  const stop = () => context.stop();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const dispatch = async (message) => {
    try {
      const response = await handleRpc(message, context);
      if (response !== null && message?.id !== undefined && (!context.stopping || context.shutdownRequested)) sendJson(response);
    } catch {
      if (message?.id !== undefined && !context.stopping) sendJson(jsonRpcError(message.id, -32603, "Internal reviewer error."));
    }
  };
  try {
    for await (const item of readBoundedLines(process.stdin)) {
      if (context.stopping) break;
      if (item.oversized) {
        sendJson(jsonRpcError(null, -32600, "Request exceeded the size limit."));
        continue;
      }
      const line = item.line?.toString("utf8") ?? "";
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        sendJson(jsonRpcError(null, -32700, "Invalid JSON."));
        continue;
      }
      const task = dispatch(message);
      context.activeTasks.add(task);
      task.finally(() => context.activeTasks.delete(task));
    }
  } catch (error) {
    if (!context.stopping || !isExpectedInputClose(error)) throw error;
  } finally {
    context.stop();
    await Promise.allSettled([...context.activeTasks]);
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}

