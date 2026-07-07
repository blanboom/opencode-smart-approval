import { basename } from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";

const readTarString = (buffer: Buffer, start: number, length: number): string => {
  const raw = buffer.subarray(start, start + length).toString("utf8");
  const nul = raw.indexOf("\0");
  return (nul >= 0 ? raw.slice(0, nul) : raw).trim();
};

const readTarOctal = (buffer: Buffer, start: number, length: number): number => {
  const raw = readTarString(buffer, start, length);
  return raw.length === 0 ? 0 : Number.parseInt(raw, 8);
};

const isZeroBlock = (buffer: Buffer): boolean => {
  return buffer.every((byte) => byte === 0);
};

export const extractBinaryFromTarGz = (archive: Buffer, binaryName: string): Buffer => {
  const tar = gunzipSync(archive);
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (isZeroBlock(header)) break;
    const name = readTarString(header, 0, 100);
    const size = readTarOctal(header, 124, 12);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (basename(name) === binaryName) return Buffer.from(tar.subarray(dataStart, dataEnd));
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  throw new Error(`archive did not contain ${binaryName}`);
};

const findEndOfCentralDirectory = (archive: Buffer): number => {
  for (let offset = archive.length - 22; offset >= 0; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("zip end of central directory not found");
};

const inflateZipEntry = (archive: Buffer, method: number, start: number, length: number): Buffer => {
  const compressed = archive.subarray(start, start + length);
  if (method === 0) return Buffer.from(compressed);
  if (method === 8) return inflateRawSync(compressed);
  throw new Error(`unsupported zip compression method ${String(method)}`);
};

export const extractBinaryFromZip = (archive: Buffer, binaryName: string): Buffer => {
  const eocd = findEndOfCentralDirectory(archive);
  const entries = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);
  for (let index = 0; index < entries; index += 1) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) throw new Error("invalid zip central directory");
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localHeaderOffset = archive.readUInt32LE(offset + 42);
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (basename(name) === binaryName) {
      if (archive.readUInt32LE(localHeaderOffset) !== 0x04034b50) throw new Error("invalid zip local header");
      const localNameLength = archive.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = archive.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
      return inflateZipEntry(archive, method, dataStart, compressedSize);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`archive did not contain ${binaryName}`);
};
