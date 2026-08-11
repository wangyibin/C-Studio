import type { PackedContactTileCells } from "./contactTileData";

export type { PackedContactTileCells } from "./contactTileData";

const contactTileBinaryHeaderBytes = 16;
const contactTileBinaryDirectoryEntryBytes = 24;
const contactTileBinaryVersion = 1;
const contactTileBinaryFlags = 0;
const maxContactTileSizeBins = 65_536;
const maxSafeUnsignedInteger = BigInt(Number.MAX_SAFE_INTEGER);

const platformIsLittleEndian = (() => {
  const word = new Uint16Array([0x0102]);
  return new Uint8Array(word.buffer)[0] === 0x02;
})();

export interface DecodedContactTileBatch {
  tileSizeBins: number;
  tiles: Array<{
    tileX: number;
    tileY: number;
    cells: [];
    packedCells: PackedContactTileCells;
  }>;
  byteLength: number;
  transport: "array_buffer";
}

interface ContactTileBinaryLayout {
  directoryIndex: number;
  tileX: number;
  tileY: number;
  count: number;
  dataOffset: number;
  xOffset: number;
  yOffset: number;
  countsOffset: number;
  dataEnd: number;
}

/** Decode the strict little-endian CST1 contact-tile binary response. */
export function decodeContactTileBinaryV1(raw: unknown): DecodedContactTileBatch {
  if (!(raw instanceof ArrayBuffer)) {
    invalidContactTileBinary("response must be an ArrayBuffer");
  }

  let view: DataView;
  try {
    view = new DataView(raw);
  } catch {
    invalidContactTileBinary("response buffer is detached");
  }
  if (raw.byteLength < contactTileBinaryHeaderBytes) {
    invalidContactTileBinary("header is truncated");
  }

  const bytes = new Uint8Array(raw);
  if (
    bytes[0] !== 0x43
    || bytes[1] !== 0x53
    || bytes[2] !== 0x54
    || bytes[3] !== 0x31
  ) {
    invalidContactTileBinary("magic must be CST1");
  }

  const version = view.getUint16(4, true);
  if (version !== contactTileBinaryVersion) {
    invalidContactTileBinary(`unsupported version ${version}`);
  }
  const flags = view.getUint16(6, true);
  if (flags !== contactTileBinaryFlags) {
    invalidContactTileBinary(`unsupported flags ${flags}`);
  }

  const tileSizeBins = view.getUint32(8, true);
  if (tileSizeBins < 1 || tileSizeBins > maxContactTileSizeBins) {
    invalidContactTileBinary(`tileSizeBins ${tileSizeBins} is outside 1..65536`);
  }
  const tileCount = view.getUint32(12, true);
  const directoryEnd = contactTileBinaryHeaderBytes
    + tileCount * contactTileBinaryDirectoryEntryBytes;
  if (directoryEnd > raw.byteLength) {
    invalidContactTileBinary("tile directory is truncated");
  }

  const layouts: ContactTileBinaryLayout[] = [];
  for (let directoryIndex = 0; directoryIndex < tileCount; directoryIndex += 1) {
    const directoryOffset = contactTileBinaryHeaderBytes
      + directoryIndex * contactTileBinaryDirectoryEntryBytes;
    const tileX = readSafeUnsigned64(view, directoryOffset, `tile ${directoryIndex} tileX`);
    const tileY = readSafeUnsigned64(view, directoryOffset + 8, `tile ${directoryIndex} tileY`);
    const count = view.getUint32(directoryOffset + 16, true);
    const dataOffset = view.getUint32(directoryOffset + 20, true);
    if (dataOffset < directoryEnd || dataOffset > raw.byteLength) {
      invalidContactTileBinary(`tile ${directoryIndex} data offset is outside the payload`);
    }
    if (dataOffset % 8 !== 0) {
      invalidContactTileBinary(`tile ${directoryIndex} data offset is not 8-byte aligned`);
    }

    const xOffset = dataOffset;
    const yOffset = xOffset + count * Uint16Array.BYTES_PER_ELEMENT;
    const packedCoordinateEnd = yOffset + count * Uint16Array.BYTES_PER_ELEMENT;
    const countsOffset = alignToEightBytes(packedCoordinateEnd);
    const dataEnd = countsOffset + count * Float64Array.BYTES_PER_ELEMENT;
    if (dataEnd > raw.byteLength) {
      invalidContactTileBinary(`tile ${directoryIndex} payload is truncated`);
    }

    layouts.push({
      directoryIndex,
      tileX,
      tileY,
      count,
      dataOffset,
      xOffset,
      yOffset,
      countsOffset,
      dataEnd,
    });
  }

  validatePackedPayloadRanges(layouts, directoryEnd, raw.byteLength);

  const tiles = layouts.map((layout) => {
    const packedCells = packedCellsForLayout(raw, view, layout);
    for (let index = 0; index < layout.count; index += 1) {
      if (
        packedCells.xLocal[index] >= tileSizeBins
        || packedCells.yLocal[index] >= tileSizeBins
      ) {
        invalidContactTileBinary(
          `tile ${layout.directoryIndex} local coordinate ${index} exceeds tileSizeBins`,
        );
      }
    }
    return {
      tileX: layout.tileX,
      tileY: layout.tileY,
      cells: [] as [],
      packedCells,
    };
  });

  return {
    tileSizeBins,
    tiles,
    byteLength: raw.byteLength,
    transport: "array_buffer",
  };
}

function packedCellsForLayout(
  buffer: ArrayBuffer,
  view: DataView,
  layout: ContactTileBinaryLayout,
): PackedContactTileCells {
  if (platformIsLittleEndian) {
    return {
      // Copy per tile so retaining one LRU entry never pins the complete IPC batch.
      xLocal: new Uint16Array(buffer, layout.xOffset, layout.count).slice(),
      yLocal: new Uint16Array(buffer, layout.yOffset, layout.count).slice(),
      counts: new Float64Array(buffer, layout.countsOffset, layout.count).slice(),
    };
  }

  const xLocal = new Uint16Array(layout.count);
  const yLocal = new Uint16Array(layout.count);
  const counts = new Float64Array(layout.count);
  for (let index = 0; index < layout.count; index += 1) {
    xLocal[index] = view.getUint16(
      layout.xOffset + index * Uint16Array.BYTES_PER_ELEMENT,
      true,
    );
    yLocal[index] = view.getUint16(
      layout.yOffset + index * Uint16Array.BYTES_PER_ELEMENT,
      true,
    );
    counts[index] = view.getFloat64(
      layout.countsOffset + index * Float64Array.BYTES_PER_ELEMENT,
      true,
    );
  }
  return { xLocal, yLocal, counts };
}

function validatePackedPayloadRanges(
  layouts: ContactTileBinaryLayout[],
  directoryEnd: number,
  byteLength: number,
) {
  const ranges = [...layouts].sort((left, right) => (
    left.dataOffset - right.dataOffset || left.dataEnd - right.dataEnd
  ));
  let packedEnd = directoryEnd;
  for (const range of ranges) {
    if (range.dataOffset < packedEnd) {
      invalidContactTileBinary(`tile ${range.directoryIndex} payload overlaps another tile`);
    }
    if (range.dataOffset > packedEnd) {
      invalidContactTileBinary(`tile ${range.directoryIndex} payload offset leaves a gap`);
    }
    packedEnd = range.dataEnd;
  }
  if (packedEnd !== byteLength) {
    invalidContactTileBinary("payload length does not match the response byte length");
  }
}

function readSafeUnsigned64(view: DataView, offset: number, field: string): number {
  const value = view.getBigUint64(offset, true);
  if (value > maxSafeUnsignedInteger) {
    invalidContactTileBinary(`${field} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return Number(value);
}

function alignToEightBytes(value: number): number {
  return Math.ceil(value / 8) * 8;
}

function invalidContactTileBinary(reason: string): never {
  throw new Error(`invalid contact tile binary v1: ${reason}`);
}
