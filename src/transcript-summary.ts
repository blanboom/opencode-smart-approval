import type { ParsedTranscriptEntry } from "./transcript-schema";

export const hasOnlyAutomaticEmptyDiffSummary = (entry: ParsedTranscriptEntry): boolean => {
  if (entry.info.role !== "user" || entry.info.summary === undefined) return false;
  return entry.info.summary.diffs.length === 0
    && entry.info.summary.title === undefined
    && entry.info.summary.body === undefined
    && Object.keys(entry.info.summary).every((key) => key === "diffs");
};

export const isMessageSummary = (entry: ParsedTranscriptEntry): boolean => entry.info.role === "user"
  ? entry.info.summary !== undefined && !hasOnlyAutomaticEmptyDiffSummary(entry)
  : entry.info.summary === true;
