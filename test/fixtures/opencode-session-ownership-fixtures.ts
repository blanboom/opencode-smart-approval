type OwnershipSession = {
  readonly permission: readonly unknown[];
  readonly revert: {
    readonly messageID: string;
    readonly partID?: string;
    readonly snapshot?: string;
    readonly diff?: string;
  };
  readonly [key: string]: unknown;
};

export const MALFORMED_OWNERSHIP_SESSION_CASES: readonly {
  readonly label: string;
  readonly mutate: (session: OwnershipSession) => unknown;
}[] = [
  { label: "permission type", mutate: (session) => ({ ...session, permission: {} }) },
  { label: "permission item type", mutate: (session) => ({ ...session, permission: ["read"] }) },
  { label: "permission missing name", mutate: (session) => ({
    ...session, permission: [{ pattern: "*", action: "allow" }],
  }) },
  { label: "permission name type", mutate: (session) => ({
    ...session, permission: [{ permission: 1, pattern: "*", action: "allow" }],
  }) },
  { label: "permission missing pattern", mutate: (session) => ({
    ...session, permission: [{ permission: "read", action: "allow" }],
  }) },
  { label: "permission pattern type", mutate: (session) => ({
    ...session, permission: [{ permission: "read", pattern: 1, action: "allow" }],
  }) },
  { label: "permission missing action", mutate: (session) => ({
    ...session, permission: [{ permission: "read", pattern: "*" }],
  }) },
  { label: "permission action", mutate: (session) => ({
    ...session, permission: [{ permission: "read", pattern: "*", action: "always" }],
  }) },
  { label: "permission action type", mutate: (session) => ({
    ...session, permission: [{ permission: "read", pattern: "*", action: 1 }],
  }) },
  { label: "permission unknown", mutate: (session) => ({
    ...session, permission: [{ permission: "read", pattern: "*", action: "allow", unexpected: true }],
  }) },
  { label: "revert type", mutate: (session) => ({ ...session, revert: [] }) },
  { label: "revert missing message", mutate: (session) => ({ ...session, revert: { partID: "prt_review" } }) },
  { label: "revert message type", mutate: (session) => ({ ...session, revert: { ...session.revert, messageID: 1 } }) },
  { label: "revert message prefix", mutate: (session) => ({
    ...session, revert: { ...session.revert, messageID: "message" },
  }) },
  { label: "revert part type", mutate: (session) => ({ ...session, revert: { ...session.revert, partID: 1 } }) },
  { label: "revert part prefix", mutate: (session) => ({ ...session, revert: { ...session.revert, partID: "part" } }) },
  { label: "revert snapshot type", mutate: (session) => ({ ...session, revert: { ...session.revert, snapshot: 1 } }) },
  { label: "revert diff type", mutate: (session) => ({ ...session, revert: { ...session.revert, diff: 1 } }) },
  { label: "revert unknown", mutate: (session) => ({ ...session, revert: { ...session.revert, unexpected: true } }) },
  { label: "top-level unknown", mutate: (session) => ({ ...session, unexpected: true }) },
];
