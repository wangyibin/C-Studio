import { invoke } from "@tauri-apps/api/core";

export type ContactMemoryCheckpointStage =
  | "ipc_received"
  | "decode_complete"
  | "react_commit"
  | "webgl_upload"
  | "first_paint"
  | "overview_start"
  | "overview_draw_entry"
  | "overview_context_acquired"
  | "overview_create_image_data_before"
  | "overview_image_data_created"
  | "overview_rgba_complete"
  | "overview_put_image_data_before"
  | "overview_put_image_data_after";

export interface ContactMemoryCheckpoint {
  stage: ContactMemoryCheckpointStage;
  generation: number;
  requestId?: number;
  targetResolution: number;
  payloadBytes?: number;
  itemCount?: number;
  frontendTimestamp?: number;
}

const checkpointStagesByGeneration = new Map<number, Set<ContactMemoryCheckpointStage>>();
const maxRetainedCheckpointGenerations = 16;

function reserveCheckpoint(generation: number, stage: ContactMemoryCheckpointStage) {
  let stages = checkpointStagesByGeneration.get(generation);
  if (!stages) {
    stages = new Set();
    checkpointStagesByGeneration.set(generation, stages);
    while (checkpointStagesByGeneration.size > maxRetainedCheckpointGenerations) {
      const oldestGeneration = checkpointStagesByGeneration.keys().next().value;
      if (oldestGeneration === undefined) {
        break;
      }
      checkpointStagesByGeneration.delete(oldestGeneration);
    }
  }
  if (stages.has(stage)) {
    return false;
  }
  stages.add(stage);
  return true;
}

/**
 * Capture one non-blocking WebContent sample for each stage of a contact-map
 * generation. The Rust command is a no-op unless CSTUDIO_PERF_LOG=1, so normal
 * builds retain the checkpoints without enabling process sampling.
 */
export function logContactMemoryCheckpoint(checkpoint: ContactMemoryCheckpoint) {
  if (
    !Number.isSafeInteger(checkpoint.generation)
    || checkpoint.generation <= 0
    || !Number.isFinite(checkpoint.targetResolution)
    || checkpoint.targetResolution <= 0
    || !reserveCheckpoint(checkpoint.generation, checkpoint.stage)
  ) {
    return;
  }
  const frontendTimestamp = checkpoint.frontendTimestamp
    ?? (typeof performance === "undefined" ? Date.now() : performance.now());
  void invoke("log_contact_webcontent_memory_checkpoint", {
    request: {
      stage: checkpoint.stage,
      generation: checkpoint.generation,
      requestId: checkpoint.requestId ?? null,
      targetResolution: Math.round(checkpoint.targetResolution),
      frontendTimestampUs: Math.round(Math.max(0, frontendTimestamp) * 1_000),
      payloadBytes: Math.max(0, Math.round(checkpoint.payloadBytes ?? 0)),
      itemCount: Math.max(0, Math.round(checkpoint.itemCount ?? 0)),
    },
  }).catch(() => {
    // Diagnostics must never interrupt contact-map loading or rendering.
  });
}
