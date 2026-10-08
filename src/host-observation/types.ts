export type FieldStatus = "AVAILABLE" | "ACCESS_DENIED" | "UNAVAILABLE" | "NOT_SUPPORTED" | "PROCESS_EXITED";
export type FieldStatuses = Record<string, FieldStatus>;
export class ObservationError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export interface RawProcess {
  pid: number; parentPid: number; name: string; exePath: string | null;
  commandLine: string | null; sessionId: number | null; startTime: string | null;
  fieldStatus?: FieldStatuses;
}
export interface ProcessRecord extends RawProcess { processKey: string | null; fieldStatus: FieldStatuses }
export interface RawListener {
  protocol: "tcp" | "udp"; localAddress: string; localPort: number; pid: number; state: string | null;
}
export interface QueryInput {
  pid?: number; name?: string; parentPid?: number; exePath?: string;
  commandContains?: string; sessionId?: number; limit: number;
}
export interface TreeInput { pid: number; direction: "ancestors" | "children" | "both"; depth: number; limit: number; processKey?: string }
export interface ListenerInput { pid?: number; port?: number; protocol?: "tcp" | "udp"; address?: string; limit: number }
/** Private typed adapter. It is never an MCP command/script interface. */
export interface ObservationProvider {
  context(): Promise<Record<string, unknown>>;
  processes(filter?: Pick<QueryInput, "pid" | "parentPid" | "name">): Promise<{ processes: RawProcess[]; truncated: boolean }>;
  listeners(filter: ListenerInput): Promise<{ listeners: RawListener[]; truncated: boolean; fieldStatus: FieldStatuses }>;
  network(): Promise<Record<string, unknown>>;
  metadata(absolutePath: string): Promise<Record<string, unknown>>;
}
