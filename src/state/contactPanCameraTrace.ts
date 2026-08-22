import { invoke } from "@tauri-apps/api/core";

type ContactPanCameraTraceValue = boolean | number | string | null | undefined | object;

const traceBuffer: string[] = [];
let traceSequence = 0;
let traceFlushTimer: ReturnType<typeof setTimeout> | null = null;
let traceAvailable: boolean | null = null;

function hasTauriRuntime() {
  if (traceAvailable !== null) {
    return traceAvailable;
  }
  traceAvailable = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  return traceAvailable;
}

function flushContactPanCameraTrace() {
  if (!hasTauriRuntime() || traceBuffer.length === 0) {
    return;
  }
  if (traceFlushTimer !== null) {
    clearTimeout(traceFlushTimer);
    traceFlushTimer = null;
  }
  const lines = traceBuffer.splice(0, traceBuffer.length);
  void invoke("log_contact_pan_camera_trace", { lines }).catch(() => undefined);
}

/**
 * Development-only camera/FBO ordering trace. Events are batched so observing
 * pointer movement does not itself add one IPC round trip to every frame.
 */
export function traceContactPanCamera(
  action: string,
  fields: Record<string, ContactPanCameraTraceValue> = {},
  flush = false,
) {
  if (!import.meta.env.DEV || !hasTauriRuntime()) {
    return;
  }
  traceBuffer.push(`CSTUDIO_CAMERA ${JSON.stringify({
    t: performance.now(),
    seq: ++traceSequence,
    action,
    ...fields,
  })}`);
  if (traceBuffer.length > 2_000) {
    traceBuffer.splice(0, traceBuffer.length - 2_000);
  }
  if (flush) {
    flushContactPanCameraTrace();
  } else if (traceFlushTimer === null) {
    traceFlushTimer = setTimeout(flushContactPanCameraTrace, 50);
  }
}
