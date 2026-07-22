import type { CreatedSessionExpectation } from "./review-session-schema";

const ownNonemptyString = (input: object, key: string): string | undefined => {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  return descriptor
    && "value" in descriptor
    && typeof descriptor.value === "string"
    && descriptor.value.length > 0
    ? descriptor.value
    : undefined;
};

export const ownedCreatedReviewSessionID = (
  input: unknown,
  expected: CreatedSessionExpectation,
): string | undefined => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const childID = ownNonemptyString(input, "id");
  if (
    childID === undefined
    || ownNonemptyString(input, "projectID") !== expected.projectID
    || ownNonemptyString(input, "directory") !== expected.directory
    || ownNonemptyString(input, "parentID") !== expected.parentID
    || ownNonemptyString(input, "title") !== expected.title
  ) return undefined;
  return childID;
};
