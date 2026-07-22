import { escapeUserFacingScalar } from "./user-facing-scalar";

export const MAX_ESCAPED_CONFIRMATION_COMMAND_UTF8_BYTES = 8_192;
export const MAX_CONFIRMATION_BODY_UTF8_BYTES = 16_384;

export type ConfirmationValues = {
  readonly command: string;
  readonly cwd: string;
  readonly action: string;
  readonly data: string;
  readonly destination: string;
  readonly risk: string;
};

export type ConfirmationChallenge = {
  readonly values: ConfirmationValues;
  readonly effectSha256: string;
  readonly disclosureSha256: string;
  readonly token: string;
  readonly replaced: boolean;
};

export type ConfirmationBodyResult =
  | { readonly ok: true; readonly body: string }
  | { readonly ok: false; readonly code: "confirmation_render_failed" };

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;

const escapedValue = (value: string): string | undefined => {
  const escaped = escapeUserFacingScalar(value);
  return escaped.ok ? escaped.value : undefined;
};

export const renderConfirmationBody = (challenge: ConfirmationChallenge): ConfirmationBodyResult => {
  if (!SHA256_HEX.test(challenge.effectSha256) || !SHA256_HEX.test(challenge.disclosureSha256)) {
    return { ok: false, code: "confirmation_render_failed" };
  }
  if (!TOKEN.test(challenge.token)) return { ok: false, code: "confirmation_render_failed" };
  const ordered = [
    ["command", challenge.values.command],
    ["cwd", challenge.values.cwd],
    ["action", challenge.values.action],
    ["data", challenge.values.data],
    ["destination", challenge.values.destination],
    ["risk", challenge.values.risk],
  ] as const;
  const escaped: string[] = [];
  for (const [label, value] of ordered) {
    const complete = escapedValue(value);
    if (complete === undefined) return { ok: false, code: "confirmation_render_failed" };
    if (label === "command" && byteLength(complete) > MAX_ESCAPED_CONFIRMATION_COMMAND_UTF8_BYTES) {
      return { ok: false, code: "confirmation_render_failed" };
    }
    escaped.push(`${label}="${complete}"`);
  }
  const body = [
    "[CommandApproval]",
    "decision=block",
    "category=security.explicit_confirmation_required;score=1",
    ...escaped,
    `effect_sha256=${challenge.effectSha256}`,
    `disclosure_sha256=${challenge.disclosureSha256}`,
    "scope=parent-session+canonical-cwd+command-effect;expires_in=300s",
    `prior_challenge_replaced=${String(challenge.replaced)}`,
    `authorization_phrase=AUTHORIZE opencode-smart-approval ${challenge.token}`,
  ].join("\n");
  return byteLength(body) <= MAX_CONFIRMATION_BODY_UTF8_BYTES
    ? { ok: true, body }
    : { ok: false, code: "confirmation_render_failed" };
};
