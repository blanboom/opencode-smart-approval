import type { UserFacingReasonSource } from "./types";

const MAX_REASON_BYTES = 1_024;
const TRUNCATION_SUFFIX = "...[truncated]";

export type EscapedUserFacingScalar =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly code: "invalid_unicode" };

export type UserFacingReason = {
  readonly source: UserFacingReasonSource;
  readonly text: string;
};

class UserFacingScalarInvariantError extends Error {
  readonly name = "UserFacingScalarInvariantError";
  constructor() {
    super("unreachable scalar escape variant");
  }
}

const assertNever = (value: never): never => {
  void value;
  throw new UserFacingScalarInvariantError();
};

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");

// This property covers every Unicode format, variation-selector, and tag scalar that can conceal text.
const DEFAULT_IGNORABLE_CODE_POINT = /^\p{Default_Ignorable_Code_Point}$/u;

const escapedUnicodeScalar = (codePoint: number): string => {
  const hexadecimal = codePoint.toString(16).toUpperCase();
  return codePoint <= 0xffff ? `\\u${hexadecimal.padStart(4, "0")}` : `\\u{${hexadecimal}}`;
};

const requiresUnicodeEscape = (scalar: string, codePoint: number): boolean => (
  (codePoint >= 0x0000 && codePoint <= 0x001f)
  || (codePoint >= 0x007f && codePoint <= 0x009f)
  || codePoint === 0x061c
  || (codePoint >= 0x200e && codePoint <= 0x200f)
  || (codePoint >= 0x2028 && codePoint <= 0x202e)
  || (codePoint >= 0x2066 && codePoint <= 0x2069)
  || codePoint === 0xfeff
  || DEFAULT_IGNORABLE_CODE_POINT.test(scalar)
);

const escapeOneScalar = (scalar: string): EscapedUserFacingScalar => {
  const codePoint = scalar.codePointAt(0);
  if (codePoint === undefined || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
    return { ok: false, code: "invalid_unicode" };
  }
  if (scalar === "\\") return { ok: true, value: "\\\\" };
  if (scalar === "\"") return { ok: true, value: "\\\"" };
  if (scalar === "`") return { ok: true, value: "\\u0060" };
  return { ok: true, value: requiresUnicodeEscape(scalar, codePoint) ? escapedUnicodeScalar(codePoint) : scalar };
};

export const escapeUserFacingScalar = (value: string): EscapedUserFacingScalar => {
  const escaped: string[] = [];
  for (const scalar of value) {
    const result = escapeOneScalar(scalar);
    switch (result.ok) {
      case true:
        escaped.push(result.value);
        break;
      case false:
        return result;
      default:
        return assertNever(result);
    }
  }
  return { ok: true, value: escaped.join("") };
};

export const renderUserFacingReason = (reason: UserFacingReason): string => {
  const prefix = `${reason.source}: `;
  const maximumContentBytes = MAX_REASON_BYTES - byteLength(prefix) - byteLength(TRUNCATION_SUFFIX);
  const complete: string[] = [];
  const truncated: string[] = [];
  let completeBytes = byteLength(prefix);
  let truncatedBytes = 0;
  let overflowed = false;
  let truncationOpen = true;
  for (const scalar of reason.text) {
    const result = escapeOneScalar(scalar);
    switch (result.ok) {
      case true: {
        const scalarBytes = byteLength(result.value);
        if (!overflowed && completeBytes + scalarBytes <= MAX_REASON_BYTES) {
          complete.push(result.value);
          completeBytes += scalarBytes;
        } else {
          overflowed = true;
        }
        if (truncationOpen && truncatedBytes + scalarBytes <= maximumContentBytes) {
          truncated.push(result.value);
          truncatedBytes += scalarBytes;
        } else {
          truncationOpen = false;
        }
        break;
      }
      case false:
        return `${prefix}[invalid-unicode]`;
      default:
        return assertNever(result);
    }
  }
  return overflowed
    ? prefix + truncated.join("") + TRUNCATION_SUFFIX
    : prefix + complete.join("");
};
