import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import type { Request, Response, NextFunction } from "express";

export type TraceRoute = "/health" | "/mcp";
export type TraceEventName =
  | "http_received"
  | "handler_start"
  | "auth_done"
  | "tool_start"
  | "tool_end"
  | "response_end"
  | "git_sync_start"
  | "git_sync_end"
  | "job_output_persist_start"
  | "job_output_persist_end"
  | "permission_poll_start"
  | "permission_poll_end"
  | "event_loop_metrics";

export type GitOperationClass = "rev-parse" | "status" | "diff" | "config" | "other";
export type GitExitStatusCategory = "success" | "nonzero" | "signal" | "timeout" | "spawn_error" | "unknown";
export type RetainedSizeBucket = "0" | "lt64k" | "64k_256k" | "256k_1m" | "1m_4m" | "gt4m";

export interface EventLoopTraceEvent {
  name: TraceEventName;
  monotonicMs: number;
  wallTime: string;
  requestId?: string;
  correlationId?: "background";
  route?: TraceRoute;
  toolName?: string;
  durationMs?: number;
  operationClass?: GitOperationClass;
  exitStatusCategory?: GitExitStatusCategory;
  timedOut?: boolean;
  streamType?: "stdout" | "stderr";
  incomingChunkBytes?: number;
  retainedSizeBucket?: RetainedSizeBucket;
  resultCategory?: "success" | "failure";
  responseCategory?: "success" | "error" | "closed";
  windowStartMs?: number;
  windowEndMs?: number;
  p50Ms?: number;
  p95Ms?: number;
  p99Ms?: number;
  maxMs?: number;
  elu?: number;
}

export interface EventLoopTraceSnapshot {
  enabled: boolean;
  events: EventLoopTraceEvent[];
  droppedEvents: number;
  maxEvents: number;
  maxEventChars: number;
  estimatedMaxMemoryBytes: number;
  metricsActive: boolean;
}

export interface TraceSpanFields {
  toolName?: string;
  operationClass?: GitOperationClass;
  exitStatusCategory?: GitExitStatusCategory;
  timedOut?: boolean;
  streamType?: "stdout" | "stderr";
  incomingChunkBytes?: number;
  retainedSizeBucket?: RetainedSizeBucket;
  resultCategory?: "success" | "failure";
  responseCategory?: "success" | "error" | "closed";
  windowStartMs?: number;
  windowEndMs?: number;
  p50Ms?: number;
  p95Ms?: number;
  p99Ms?: number;
  maxMs?: number;
  elu?: number;
}

type TraceContext = { requestId: string; route: TraceRoute };
type SpanKind = "tool" | "git_sync" | "job_output_persist" | "permission_poll";
type SpanEnd = (fields?: TraceSpanFields) => void;
const NOOP_SPAN: SpanEnd = () => undefined;

export const MAX_TRACE_EVENTS = 2048;
export const MAX_TRACE_EVENT_CHARS = 1024;
// Each retained JSON string is capped at 1024 UTF-16 code units. The 5 MiB
// ceiling includes a conservative 2-byte-per-code-unit allowance and the
// fixed ring's references and bookkeeping.
export const MAX_TRACE_MEMORY_BYTES = 5 * 1024 * 1024;

const traceContext = new AsyncLocalStorage<TraceContext>();
const OPERATION_CLASSES = new Set<GitOperationClass>(["rev-parse", "status", "diff", "config", "other"]);
const EXIT_CATEGORIES = new Set<GitExitStatusCategory>(["success", "nonzero", "signal", "timeout", "spawn_error", "unknown"]);
const RETAINED_BUCKETS = new Set<RetainedSizeBucket>(["0", "lt64k", "64k_256k", "256k_1m", "1m_4m", "gt4m"]);

class TraceRingBuffer {
  private readonly items = new Array<string | undefined>(MAX_TRACE_EVENTS);
  private next = 0;
  private count = 0;
  private dropped = 0;

  append(event: EventLoopTraceEvent): void {
    let serialized: string;
    try {
      serialized = JSON.stringify(event);
    } catch {
      this.dropped += 1;
      return;
    }
    if (serialized.length > MAX_TRACE_EVENT_CHARS) {
      this.dropped += 1;
      return;
    }
    this.items[this.next] = serialized;
    if (this.count === MAX_TRACE_EVENTS) this.dropped += 1;
    else this.count += 1;
    this.next = (this.next + 1) % MAX_TRACE_EVENTS;
  }

  snapshot(): EventLoopTraceEvent[] {
    const first = this.count === MAX_TRACE_EVENTS ? this.next : 0;
    const events: EventLoopTraceEvent[] = [];
    for (let index = 0; index < this.count; index += 1) {
      const serialized = this.items[(first + index) % MAX_TRACE_EVENTS];
      if (!serialized) continue;
      try {
        events.push(JSON.parse(serialized) as EventLoopTraceEvent);
      } catch {
        // Corrupt diagnostic data is skipped; it cannot affect bridge behavior.
      }
    }
    return events;
  }

  get droppedEvents(): number { return this.dropped; }
}

let buffer: TraceRingBuffer | null = null;
let delayHistogram: ReturnType<typeof monitorEventLoopDelay> | null = null;
let metricsTimer: NodeJS.Timeout | null = null;
let previousElu: ReturnType<typeof performance.eventLoopUtilization> | null = null;
let windowStartMs = 0;

export function isEventLoopTraceEnabled(): boolean {
  return process.env.C2C_EVENT_LOOP_TRACE === "1";
}

function clampNumber(value: unknown, max = 86_400_000): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(value, max)
    : undefined;
}

function safeFields(fields: TraceSpanFields | Record<string, unknown>): TraceSpanFields {
  const candidate = fields as Record<string, unknown>;
  const safe: TraceSpanFields = {};
  if (typeof candidate.toolName === "string" && /^[a-z0-9_]{1,64}$/i.test(candidate.toolName)) {
    safe.toolName = candidate.toolName;
  }
  if (typeof candidate.operationClass === "string" && OPERATION_CLASSES.has(candidate.operationClass as GitOperationClass)) {
    safe.operationClass = candidate.operationClass as GitOperationClass;
  }
  if (typeof candidate.exitStatusCategory === "string" && EXIT_CATEGORIES.has(candidate.exitStatusCategory as GitExitStatusCategory)) {
    safe.exitStatusCategory = candidate.exitStatusCategory as GitExitStatusCategory;
  }
  if (typeof candidate.timedOut === "boolean") safe.timedOut = candidate.timedOut;
  if (candidate.streamType === "stdout" || candidate.streamType === "stderr") safe.streamType = candidate.streamType;
  const chunkBytes = clampNumber(candidate.incomingChunkBytes, 64 * 1024);
  if (chunkBytes !== undefined) safe.incomingChunkBytes = Math.floor(chunkBytes);
  if (typeof candidate.retainedSizeBucket === "string" && RETAINED_BUCKETS.has(candidate.retainedSizeBucket as RetainedSizeBucket)) {
    safe.retainedSizeBucket = candidate.retainedSizeBucket as RetainedSizeBucket;
  }
  if (candidate.resultCategory === "success" || candidate.resultCategory === "failure") {
    safe.resultCategory = candidate.resultCategory;
  }
  return safe;
}

function stopMetrics(): void {
  if (metricsTimer) clearInterval(metricsTimer);
  metricsTimer = null;
  try { delayHistogram?.disable(); } catch { /* diagnostics never affect bridge work */ }
  delayHistogram = null;
  previousElu = null;
}

function ensureMetrics(): void {
  if (!isEventLoopTraceEnabled() || metricsTimer) return;
  try {
    const histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();
    delayHistogram = histogram;
    previousElu = performance.eventLoopUtilization();
    windowStartMs = performance.now();
    metricsTimer = setInterval(() => traceContext.exit(collectMetrics), 1000);
    metricsTimer.unref?.();
  } catch {
    stopMetrics();
  }
}

function histogramMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(value / 1_000_000, 86_400_000);
}

function collectMetrics(): void {
  if (!isEventLoopTraceEnabled()) {
    stopMetrics();
    return;
  }
  const histogram = delayHistogram;
  if (!histogram) return;
  try {
    const endMs = performance.now();
    const eluDelta = previousElu ? performance.eventLoopUtilization(previousElu) : performance.eventLoopUtilization();
    previousElu = performance.eventLoopUtilization();
    appendEvent("event_loop_metrics", {
      windowStartMs,
      windowEndMs: endMs,
      p50Ms: histogramMs(histogram.percentile(50)),
      p95Ms: histogramMs(histogram.percentile(95)),
      p99Ms: histogramMs(histogram.percentile(99)),
      maxMs: histogramMs(histogram.max),
      elu: clampNumber(eluDelta.utilization, 1),
    }, true);
    histogram.reset();
    windowStartMs = endMs;
  } catch {
    // A metrics sample is optional and cannot fail a request or background job.
  }
}

function traceContextFields(): Pick<EventLoopTraceEvent, "requestId" | "correlationId" | "route"> {
  const context = traceContext.getStore();
  if (context && /^[0-9a-f-]{36}$/i.test(context.requestId) && (context.route === "/health" || context.route === "/mcp")) {
    return { requestId: context.requestId, route: context.route };
  }
  return { correlationId: "background" };
}

function appendEvent(name: TraceEventName, fields: TraceSpanFields | Record<string, unknown> = {}, forceBackground = false): void {
  if (!isEventLoopTraceEnabled()) {
    stopMetrics();
    return;
  }
  try {
    ensureMetrics();
    buffer ??= new TraceRingBuffer();
    const monotonicMs = performance.now();
    const event: EventLoopTraceEvent = {
      name,
      monotonicMs,
      wallTime: new Date().toISOString(),
      ...(forceBackground ? { correlationId: "background" as const } : traceContextFields()),
      ...safeFields(fields),
    };
    const metrics = fields as Record<string, unknown>;
    if (name === "event_loop_metrics") {
      const windowStart = clampNumber(metrics.windowStartMs);
      const windowEnd = clampNumber(metrics.windowEndMs);
      const p50 = clampNumber(metrics.p50Ms);
      const p95 = clampNumber(metrics.p95Ms);
      const p99 = clampNumber(metrics.p99Ms);
      const max = clampNumber(metrics.maxMs);
      const elu = clampNumber(metrics.elu, 1);
      if (windowStart !== undefined) event.windowStartMs = windowStart;
      if (windowEnd !== undefined) event.windowEndMs = windowEnd;
      if (p50 !== undefined) event.p50Ms = p50;
      if (p95 !== undefined) event.p95Ms = p95;
      if (p99 !== undefined) event.p99Ms = p99;
      if (max !== undefined) event.maxMs = max;
      if (elu !== undefined) event.elu = elu;
    }
    if (name === "response_end") {
      const category = metrics.responseCategory;
      if (category === "success" || category === "error" || category === "closed") {
        event.responseCategory = category;
      }
    }
    if (name === "git_sync_end" || name === "job_output_persist_end" || name === "permission_poll_end" || name === "tool_end") {
      const duration = clampNumber(metrics.durationMs);
      if (duration !== undefined) event.durationMs = duration;
    }
    buffer.append(event);
  } catch {
    // Tracing is best effort and never changes the operation being measured.
  }
}

export function recordEventLoopTrace(name: TraceEventName, fields: TraceSpanFields = {}): void {
  appendEvent(name, fields);
}

export function beginEventLoopTraceSpan(kind: SpanKind, fields: TraceSpanFields = {}, forceBackground = false): SpanEnd {
  if (!isEventLoopTraceEnabled()) return NOOP_SPAN;
  let startedAt: number;
  let startFields: TraceSpanFields;
  try {
    startedAt = performance.now();
    startFields = safeFields(fields);
  } catch {
    return NOOP_SPAN;
  }
  const startName: TraceEventName = kind === "tool" ? "tool_start" : `${kind}_start` as TraceEventName;
  const endName: TraceEventName = kind === "tool" ? "tool_end" : `${kind}_end` as TraceEventName;
  appendEvent(startName, startFields, forceBackground);
  let ended = false;
  return (endFields = {}) => {
    if (ended) return;
    ended = true;
    try {
      const durationMs = Math.max(0, performance.now() - startedAt);
      appendEvent(endName, { ...startFields, ...safeFields(endFields), durationMs }, forceBackground);
    } catch {
      // A missing end event is preferable to changing application behavior.
    }
  };
}

export function runWithEventLoopTraceContext<T>(context: TraceContext, callback: () => T): T {
  return traceContext.run(context, callback);
}

export function currentEventLoopTraceContext(): Readonly<TraceContext> | undefined {
  return traceContext.getStore();
}

export function eventLoopTraceMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!isEventLoopTraceEnabled()) {
    next();
    return;
  }
  const route = req.path === "/health" || req.path === "/mcp" ? req.path : null;
  if (!route) {
    next();
    return;
  }
  const context: TraceContext = { requestId: randomUUID(), route };
  runWithEventLoopTraceContext(context, () => {
    recordEventLoopTrace("http_received");
    let ended = false;
    const finish = (closed: boolean): void => {
      if (ended) return;
      ended = true;
      const responseCategory = closed && !res.writableFinished
        ? "closed"
        : res.statusCode >= 400 ? "error" : "success";
      recordEventLoopTrace("response_end", { responseCategory });
    };
    res.once("finish", () => finish(false));
    res.once("close", () => finish(true));
    next();
  });
}

export function getEventLoopTraceSnapshot(): EventLoopTraceSnapshot {
  const enabled = isEventLoopTraceEnabled();
  return {
    enabled,
    events: enabled ? buffer?.snapshot() ?? [] : [],
    droppedEvents: enabled ? buffer?.droppedEvents ?? 0 : 0,
    maxEvents: MAX_TRACE_EVENTS,
    maxEventChars: MAX_TRACE_EVENT_CHARS,
    estimatedMaxMemoryBytes: MAX_TRACE_MEMORY_BYTES,
    metricsActive: enabled && metricsTimer !== null,
  };
}
