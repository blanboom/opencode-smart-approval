import { defaultRules } from "./default-rules";
import type { ApprovalPolicy, TirithConfig, SelfProtectionConfig } from "./types";

export const DEFAULT_TIRITH = {
  enabled: true,
  timeoutMs: 5_000,
  failOpen: false,
} as const satisfies TirithConfig;

export const DEFAULT_SELF_PROTECTION = {
  enabled: true,
} as const satisfies SelfProtectionConfig;

export const defaultPolicy = (): ApprovalPolicy => ({
  review: {
    timeoutMs: 45_000,
    contextMessages: 20,
    cleanupSession: true,
  },
  tirith: DEFAULT_TIRITH,
  selfProtection: DEFAULT_SELF_PROTECTION,
  rules: defaultRules(),
});

const defaultConfigObject = () => ({
  version: 3,
  allow_local_config: false,
  self_protection: DEFAULT_SELF_PROTECTION,
  review: {},
  tirith: {
    enabled: DEFAULT_TIRITH.enabled,
    timeout_ms: DEFAULT_TIRITH.timeoutMs,
    fail_open: DEFAULT_TIRITH.failOpen,
  },
  rules: {
    deny: [],
    review: [],
    allow: [],
  },
});

export const defaultConfigJson = (): string => {
  const header = [
    "// CommandApproval config. JSON with comments are supported.",
    "// Project-local config is ignored unless this trusted global file sets allow_local_config to true.",
    "// Decision order: user rules, small built-in rules, Tirith, then the direct OpenCode approval agent.",
    "// A complete user allow or deny is terminal and skips every later stage.",
    "// Built-in rules are applied automatically; add only personal overrides below.",
    "// This file uses strict policy version 3; unknown fields and older formats are rejected.",
    "// Rule objects support scope: command|segment and an integer priority.",
    "// Pipeline/list commands short-circuit only when every static executable segment is allowed.",
    "// self_protection.enabled defaults to true and blocks edits to this policy via shell and file-edit tools.",
    "// review.model is optional; OpenCode small_model is used when it is absent.",
  ].join("\n");
  return `${header}\n${JSON.stringify(defaultConfigObject(), null, 2)}\n`;
};
