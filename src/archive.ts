import { basename } from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";

export const MAX_EXTRACTED_ARCHIVE_BYTES = 128 * 1024 * 1024;
export const MAX_EXTRACTED_BINARY_BYTES = 32 * 1024 * 1024;

const ensureRange = (buffer: Buffer, start: number, length: number, label: string): void => {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start > buffer.length - length) {
    throw new Error(`${label} is outside the archive bounds`);
  }
};

const readTarString = (buffer: Buffer, start: number, length: number): string => {
  const raw = buffer.subarray(start, start + length).toString("utf8");
  const nul = raw.indexOf("\0");
  return (nul >= 0 ? raw.slice(0, nul) : raw).trim();
};

const readTarOctal = (buffer: Buffer, start: number, length: number): number => {
  const raw = readTarString(buffer, start, length);
  if (raw.length === 0) return 0;
  if (!/^[0-7]+$/u.test(raw)) throw new Error("invalid tar size field");
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value)) throw new Error("tar size exceeds the supported range");
  return value;
};

const isZeroBlock = (buffer: Buffer): boolean => {
  return buffer.every((byte) => byte === 0);
};

export const extractBinaryFromTarGz = (archive: Buffer, binaryName: string): Buffer => {
  const tar = gunzipSync(archive, { maxOutputLength: MAX_EXTRACTED_ARCHIVE_BYTES });
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (isZeroBlock(header)) break;
    const name = readTarString(header, 0, 100);
    const size = readTarOctal(header, 124, 12);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    ensureRange(tar, dataStart, size, "tar entry");
    if (basename(name) === binaryName) {
      if (size > MAX_EXTRACTED_BINARY_BYTES) throw new Error("Tirith binary exceeds the extraction limit");
      return Buffer.from(tar.subarray(dataStart, dataEnd));
    }
    const paddedSize = Math.ceil(size / 512) * 512;
    ensureRange(tar, dataStart, paddedSize, "tar padded entry");
    offset = dataStart + paddedSize;
  }
  throw new Error(`archive did not contain ${binaryName}`);
};

const findEndOfCentralDirectory = (archive: Buffer): number => {
  if (archive.length < 22) throw new Error("zip archive is too short");
  const minimum = Math.max(0, archive.length - 22 - 0xffff);
  for (let offset = archive.length - 22; offset >= minimum; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("zip end of central directory not found");
};

const inflateZipEntry = (
  archive: Buffer,
  method: number,
  start: number,
  length: number,
  expectedLength: number,
): Buffer => {
  ensureRange(archive, start, length, "zip entry");
  if (expectedLength > MAX_EXTRACTED_BINARY_BYTES) throw new Error("Tirith binary exceeds the extraction limit");
  const compressed = archive.subarray(start, start + length);
  const result = method === 0
    ? Buffer.from(compressed)
    : method === 8
      ? inflateRawSync(compressed, { maxOutputLength: MAX_EXTRACTED_BINARY_BYTES })
      : undefined;
  if (!result) throw new Error(`unsupported zip compression method ${String(method)}`);
  if (result.length !== expectedLength) throw new Error("zip entry size does not match its central-directory metadata");
  return result;
};

export const extractBinaryFromZip = (archive: Buffer, binaryName: string): Buffer => {
  const eocd = findEndOfCentralDirectory(archive);
  ensureRange(archive, eocd, 22, "zip end of central directory");
  const entries = archive.readUInt16LE(eocd + 10);
  if (entries > 4_096) throw new Error("zip archive contains too many entries");
  const centralSize = archive.readUInt32LE(eocd + 12);
  let offset = archive.readUInt32LE(eocd + 16);
  ensureRange(archive, offset, centralSize, "zip central directory");
  if (offset + centralSize > eocd) throw new Error("zip central directory overlaps its trailer");
  for (let index = 0; index < entries; index += 1) {
    ensureRange(archive, offset, 46, "zip central-directory entry");
    if (archive.readUInt32LE(offset) !== 0x02014b50) throw new Error("invalid zip central directory");
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localHeaderOffset = archive.readUInt32LE(offset + 42);
    const entryLength = 46 + nameLength + extraLength + commentLength;
    ensureRange(archive, offset, entryLength, "zip central-directory entry");
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (basename(name) === binaryName) {
      if ((flags & 1) !== 0) throw new Error("encrypted zip entries are not supported");
      ensureRange(archive, localHeaderOffset, 30, "zip local header");
      if (archive.readUInt32LE(localHeaderOffset) !== 0x04034b50) throw new Error("invalid zip local header");
      if (archive.readUInt16LE(localHeaderOffset + 8) !== method) throw new Error("zip compression metadata is inconsistent");
      const localNameLength = archive.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = archive.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
      return inflateZipEntry(archive, method, dataStart, compressedSize, uncompressedSize);
    }
    offset += entryLength;
  }
  throw new Error(`archive did not contain ${binaryName}`);
};
