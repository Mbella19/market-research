import { EventEmitter } from "node:events";
import { run } from "../db.ts";
import { redactSecrets, redactValue } from "./secrets.ts";

export type ScanEventType = "log" | "warn" | "stage" | "progress" | "done" | "cancelled" | "error";

export interface ScanEvent {
  scanId: number;
  ts: number;
  type: ScanEventType;
  message: string;
  data?: unknown;
}

const bus = new EventEmitter();
bus.setMaxListeners(200);

export function emitScanEvent(
  scanId: number,
  type: ScanEventType,
  message: string,
  data?: unknown
): void {
  const safeMessage = redactSecrets(message);
  const safeData = data === undefined ? undefined : redactValue(data);
  const ev: ScanEvent = { scanId, ts: Date.now(), type, message: safeMessage, data: safeData };
  // "progress" fires constantly — stream it live but don't spam the event log table.
  if (type !== "progress") {
    run(
      "INSERT INTO events (scan_id, ts, type, message, data_json) VALUES (?, ?, ?, ?, ?)",
      scanId,
      ev.ts,
      type,
      safeMessage,
      safeData === undefined ? null : JSON.stringify(safeData)
    );
  }
  bus.emit(`scan:${scanId}`, ev);
}

export function onScanEvent(scanId: number, listener: (ev: ScanEvent) => void): () => void {
  const channel = `scan:${scanId}`;
  bus.on(channel, listener);
  return () => bus.off(channel, listener);
}
