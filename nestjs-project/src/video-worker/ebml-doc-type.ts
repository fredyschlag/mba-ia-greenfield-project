const EBML_HEADER_ID = 0x1a45dfa3;
const EBML_DOC_TYPE_ID = 0x4282;

interface Vint {
  value: number;
  length: number;
}

function readVint(buffer: Buffer, offset: number, keepMarker: boolean) {
  if (offset >= buffer.length) {
    return null;
  }
  const first = buffer[offset];
  if (first === 0) {
    return null;
  }
  const length = Math.clz32(first) - 23;
  if (offset + length > buffer.length) {
    return null;
  }
  let value = keepMarker ? first : first & (0xff >> length);
  for (let index = 1; index < length; index += 1) {
    value = value * 256 + buffer[offset + index];
  }
  return { value, length } satisfies Vint;
}

/** Reads the DocType from the EBML header, or null when it is not present. */
export function parseEbmlDocType(buffer: Buffer): string | null {
  const headerId = readVint(buffer, 0, true);
  if (headerId?.value !== EBML_HEADER_ID) {
    return null;
  }
  const headerSize = readVint(buffer, headerId.length, false);
  if (!headerSize) {
    return null;
  }

  let offset = headerId.length + headerSize.length;
  const end = Math.min(offset + headerSize.value, buffer.length);
  while (offset < end) {
    const id = readVint(buffer, offset, true);
    if (!id) {
      return null;
    }
    const size = readVint(buffer, offset + id.length, false);
    if (!size) {
      return null;
    }
    const dataStart = offset + id.length + size.length;
    const dataEnd = dataStart + size.value;
    if (dataEnd > end) {
      return null;
    }
    if (id.value === EBML_DOC_TYPE_ID) {
      return buffer
        .subarray(dataStart, dataEnd)
        .toString('ascii')
        .replace(/\0+$/, '');
    }
    offset = dataEnd;
  }
  return null;
}
