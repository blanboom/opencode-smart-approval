import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");

const releaseHeader = `name: Release

on:
  push:
    tags:
      - "v*"

permissions:
  contents: read

`;

const expectedPublishJob = `  publish:
    needs: verify
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
        with:
          ref: \${{ github.sha }}
          persist-credentials: false

      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6
        with:
          node-version: 24.18.0
          package-manager-cache: false

      - run: npm publish --ignore-scripts --access public --provenance --registry=https://registry.npmjs.org

`;

const jobBlock = (name: string): string => {
  const marker = `  ${name}:\n`;
  const start = workflow.indexOf(marker);
  if (start === -1) throw new Error(`missing ${name} job`);
  const remainder = workflow.slice(start + marker.length);
  const nextJob = remainder.search(/^  [a-z0-9-]+:\n/m);
  return nextJob === -1 ? workflow.slice(start) : workflow.slice(start, start + marker.length + nextJob);
};

describe("release workflow security boundary", () => {
  test("keeps mutable verification code outside the OIDC-enabled publish job", () => {
    // Given: the complete release workflow and its privileged publish job.
    const verify = jobBlock("verify");
    const publish = jobBlock("publish");

    // When: the workflow's OIDC and pre-publish execution boundaries are inspected.
    const oidcGrants = workflow.match(/^\s+id-token: write$/gm) ?? [];

    // Then: only the minimal publish job has OIDC and publishes from a clean checkout.
    expect(workflow.slice(0, workflow.indexOf("jobs:"))).toBe(releaseHeader);
    expect(oidcGrants).toHaveLength(1);
    expect(verify).toContain('test "v${PACKAGE_VERSION}" = "${GITHUB_REF_NAME}"');
    expect(publish).toBe(expectedPublishJob);
  });

  test("pins every release action to an immutable commit", () => {
    // Given: every action reference used by the release workflow.
    const actionRefs = [...workflow.matchAll(/uses:\s+[^@\s]+@([^\s#]+)/g)].map((match) => match[1]);

    // When: the action revisions are classified by shape.
    const immutableRefs = actionRefs.filter((revision) => /^[a-f0-9]{40}$/.test(revision ?? ""));

    // Then: mutable tags and branches are absent.
    expect(actionRefs.length).toBeGreaterThan(0);
    expect(immutableRefs).toHaveLength(actionRefs.length);
  });
});
