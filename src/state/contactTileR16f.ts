export const contactTileR16fEmptySentinel = 0xbc00;

export function contactTileR16fIsFinite(value: number): boolean {
  return (value & 0x7c00) !== 0x7c00;
}

/** Decode one IEEE-754 binary16 bit pattern without allocating a Float32 view. */
export function contactTileR16fToFloat32(value: number): number {
  const sign = (value & 0x8000) === 0 ? 1 : -1;
  const exponent = (value >> 10) & 0x1f;
  const mantissa = value & 0x03ff;
  if (exponent === 0) {
    if (mantissa === 0) {
      return sign === 1 ? 0 : -0;
    }
    return sign * mantissa * 2 ** -24;
  }
  if (exponent === 0x1f) {
    return mantissa === 0 ? sign * Number.POSITIVE_INFINITY : Number.NaN;
  }
  return sign * (1 + mantissa / 0x400) * 2 ** (exponent - 15);
}

export function contactTileR16fValuesToFloat32(
  values: Uint16Array,
  target: Float32Array = new Float32Array(values.length),
): Float32Array {
  if (target.length !== values.length) {
    throw new RangeError("R16F conversion target length mismatch");
  }
  for (let index = 0; index < values.length; index += 1) {
    target[index] = contactTileR16fToFloat32(values[index]);
  }
  return target;
}
