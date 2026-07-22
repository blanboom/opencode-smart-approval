import { APPROVAL_AGENT_NAME } from "./approval-agent-contract";
import type { ReviewCleanupResult, ReviewHandle } from "./review-handle";

export interface ReviewRegistry {
  add(handle: ReviewHandle): boolean;
  get(childID: string): ReviewHandle | undefined;
  idle(childID: string, directory: string): Promise<ReviewCleanupResult | undefined>;
  deleted(childID: string, directory: string): boolean;
  dispose(directory: string): Promise<readonly ReviewCleanupResult[]>;
}

export const createReviewRegistry = (): ReviewRegistry => {
  const handles = new Map<string, ReviewHandle>();
  const owned = (childID: string, directory: string): ReviewHandle | undefined => {
    const handle = handles.get(childID);
    return handle?.agentType === APPROVAL_AGENT_NAME && handle.directory === directory
      ? handle
      : undefined;
  };
  return Object.freeze({
    add: (handle: ReviewHandle): boolean => {
      if (
        handle.childID.length === 0 ||
        handle.directory.length === 0 ||
        handle.agentType !== APPROVAL_AGENT_NAME ||
        handles.has(handle.childID)
      ) return false;
      handles.set(handle.childID, handle);
      if (!handle.onTerminal(() => {
        if (handles.get(handle.childID) === handle) handles.delete(handle.childID);
      })) {
        handles.delete(handle.childID);
        return false;
      }
      return true;
    },
    get: (childID: string): ReviewHandle | undefined => handles.get(childID),
    idle: async (childID: string, directory: string): Promise<ReviewCleanupResult | undefined> => {
      const handle = owned(childID, directory);
      if (!handle) return undefined;
      handle.settlePrompt();
      return handle.cleanup(false);
    },
    deleted: (childID: string, directory: string): boolean => owned(childID, directory)?.observeDeleted() ?? false,
    dispose: async (directory: string): Promise<readonly ReviewCleanupResult[]> => {
      const matching = [...handles.values()].filter((handle) =>
        handle.agentType === APPROVAL_AGENT_NAME && handle.directory === directory);
      return Promise.all(matching.map((handle) => handle.cleanup(true)));
    },
  });
};
