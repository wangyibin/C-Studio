import { exportAgpText } from "./agpExport";
import type { AssemblySelection } from "./assemblyEditing";
import type { ContactMapLayoutBlock } from "./importers";
import type {
  AssemblyHistorySnapshot,
  ContextOperationType,
  OperationImpact,
  OperationRecord,
} from "./uiState";

const historyFormat = "c-studio-operation-history";
const historyVersion = 1;

const operationTypes = new Set<ContextOperationType>([
  "delete_contig",
  "move_to_debris",
  "remove_chr_boundaries",
  "add_chr_boundaries",
  "copy_new",
  "copy_to_group",
  "reverse",
  "move",
  "split_contig",
  "delete_gap",
  "rename",
  "create_block",
  "place_unplaced",
  "dissolve_block",
]);

export interface OperationHistoryArchive {
  operationHistory: OperationRecord[];
  redoStack: OperationRecord[];
  nextOperationId: number;
}

interface OperationHistoryDocumentV1 extends OperationHistoryArchive {
  format: typeof historyFormat;
  version: typeof historyVersion;
  canonicalAgp: string;
}

export function serializeOperationHistory({
  canonicalAgp,
  operationHistory,
  redoStack,
  nextOperationId,
}: OperationHistoryArchive & { canonicalAgp: string }): string {
  const document: OperationHistoryDocumentV1 = {
    format: historyFormat,
    version: historyVersion,
    canonicalAgp,
    operationHistory,
    redoStack,
    nextOperationId,
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function parseOperationHistory(
  text: string,
  expectedCanonicalAgp: string,
): OperationHistoryArchive {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`history sidecar is not valid JSON: ${String(error)}`);
  }
  if (!isRecord(value) || value.format !== historyFormat || value.version !== historyVersion) {
    throw new Error("history sidecar has an unsupported format or version");
  }
  if (value.canonicalAgp !== expectedCanonicalAgp) {
    throw new Error("history sidecar does not match the imported AGP contents");
  }
  if (!Array.isArray(value.operationHistory) || !Array.isArray(value.redoStack)) {
    throw new Error("history sidecar is missing its operation lists");
  }

  const operationHistory = value.operationHistory.map((entry, index) => (
    parseOperation(entry, `operationHistory[${index}]`)
  ));
  const redoStack = value.redoStack.map((entry, index) => (
    parseOperation(entry, `redoStack[${index}]`)
  ));
  const ids = [...operationHistory, ...redoStack].map((operation) => operation.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("history sidecar contains duplicate operation IDs");
  }
  const minimumNextId = Math.max(0, ...ids) + 1;
  if (!isPositiveInteger(value.nextOperationId) || value.nextOperationId < minimumNextId) {
    throw new Error("history sidecar has an invalid next operation ID");
  }

  validateCurrentSnapshot(operationHistory, redoStack, expectedCanonicalAgp);
  return { operationHistory, redoStack, nextOperationId: value.nextOperationId };
}

export function operationHistoryFilename(agpPath: string): string {
  const basename = agpPath.split(/[\\/]/).filter(Boolean).pop() ?? "assembly.agp";
  const withoutCompression = basename.replace(/\.gz$/i, "");
  const prefix = withoutCompression.replace(/\.(?:agp|txt)$/i, "");
  return `${prefix || "assembly"}.history.json`;
}

function parseOperation(value: unknown, path: string): OperationRecord {
  if (!isRecord(value)
    || !isPositiveInteger(value.id)
    || typeof value.type !== "string"
    || !operationTypes.has(value.type as ContextOperationType)
    || typeof value.label !== "string"
    || !isPosition(value.position)) {
    throw new Error(`history sidecar contains an invalid ${path}`);
  }
  const beforeAssembly = value.beforeAssembly === undefined
    ? undefined
    : parseSnapshot(value.beforeAssembly, `${path}.beforeAssembly`);
  const afterAssembly = value.afterAssembly === undefined
    ? undefined
    : parseSnapshot(value.afterAssembly, `${path}.afterAssembly`);
  const impact = value.impact === undefined
    ? undefined
    : parseImpact(value.impact, `${path}.impact`);
  return {
    id: value.id,
    type: value.type as ContextOperationType,
    label: value.label,
    position: { x: value.position.x, y: value.position.y },
    ...(beforeAssembly ? { beforeAssembly } : {}),
    ...(afterAssembly ? { afterAssembly } : {}),
    ...(impact ? { impact } : {}),
  };
}

function parseSnapshot(value: unknown, path: string): AssemblyHistorySnapshot {
  if (!isRecord(value) || !Array.isArray(value.blocks)) {
    throw new Error(`history sidecar contains an invalid ${path}`);
  }
  const blocks = value.blocks.map((block, index) => parseBlock(block, `${path}.blocks[${index}]`));
  const selection = parseSelection(value.selection, `${path}.selection`);
  return { blocks, selection };
}

function parseBlock(value: unknown, path: string): ContactMapLayoutBlock {
  if (!isRecord(value)
    || typeof value.id !== "string"
    || typeof value.objectId !== "string"
    || typeof value.sourceId !== "string"
    || !isFiniteNumber(value.sourceStart)
    || !isFiniteNumber(value.sourceEnd)
    || !isFiniteNumber(value.visualStart)
    || !isFiniteNumber(value.visualEnd)
    || !["+", "-", "?", "0", "na"].includes(String(value.orientation))) {
    throw new Error(`history sidecar contains an invalid ${path}`);
  }
  return value as unknown as ContactMapLayoutBlock;
}

function parseImpact(value: unknown, path: string): OperationImpact {
  if (!isRecord(value)
    || !isStringArray(value.blockIds)
    || !isStringArray(value.sourceIds)
    || !isStringArray(value.chromosomeIds)) {
    throw new Error(`history sidecar contains an invalid ${path}`);
  }
  return {
    blockIds: [...value.blockIds],
    sourceIds: [...value.sourceIds],
    chromosomeIds: [...value.chromosomeIds],
    selection: parseSelection(value.selection, `${path}.selection`),
  };
}

function parseSelection(value: unknown, path: string): AssemblySelection | null {
  if (value === null) return null;
  if (!isRecord(value) || (value.kind !== "contigs" && value.kind !== "chromosome")) {
    throw new Error(`history sidecar contains an invalid ${path}`);
  }
  if (value.kind === "chromosome") {
    if (typeof value.id !== "string") {
      throw new Error(`history sidecar contains an invalid ${path}`);
    }
    return { kind: "chromosome", id: value.id };
  }
  if (!isStringArray(value.ids) || (value.exact !== undefined && typeof value.exact !== "boolean")) {
    throw new Error(`history sidecar contains an invalid ${path}`);
  }
  return {
    kind: "contigs",
    ids: [...value.ids],
    ...(value.exact === true ? { exact: true } : {}),
  };
}

function validateCurrentSnapshot(
  operationHistory: OperationRecord[],
  redoStack: OperationRecord[],
  expectedCanonicalAgp: string,
) {
  const currentSnapshot = operationHistory[operationHistory.length - 1]?.afterAssembly
    ?? redoStack[redoStack.length - 1]?.beforeAssembly;
  if (currentSnapshot && exportAgpText(currentSnapshot.blocks) !== expectedCanonicalAgp) {
    throw new Error("history sidecar current snapshot does not match the imported AGP");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function isPosition(value: unknown): value is { x: number; y: number } {
  return isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}
