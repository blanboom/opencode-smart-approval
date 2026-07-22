import { readerError, type AnchoredFsAdapter, type DescriptorStat } from "./anchored-fs";

export const createUnsupportedAnchoredFsAdapter = (): AnchoredFsAdapter => Object.freeze({
  available: false,
  openRoot: () => readerError<number>("reader_unavailable"),
  openAt: () => readerError<number>("reader_unavailable"),
  stat: () => readerError<DescriptorStat>("reader_unavailable"),
  read: () => readerError<Uint8Array>("reader_unavailable"),
  close: () => readerError<undefined>("reader_unavailable"),
  dispose: () => undefined,
});
