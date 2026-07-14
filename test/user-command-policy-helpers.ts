import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultPolicy } from "../src/default-config";
import { parsePolicyJsonc, policyFromUnknown } from "../src/policy-parser";

export const userPolicy = () => {
  const fixture = readFileSync(
    join(import.meta.dir, "fixtures", "user-command-approval.redacted.jsonc"),
    "utf8",
  );
  return policyFromUnknown(parsePolicyJsonc(fixture), defaultPolicy().rules);
};
