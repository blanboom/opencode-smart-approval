import { describe, expect, test } from "bun:test";
import {
  parseRetainedChild,
  parseRetainedReaderProbe,
  requireRetainedStatusAbsent,
} from "../scripts/opencode-e2e/retained";

const child = {
  id: "ses_child",
  slug: "review-child",
  projectID: "project-id",
  directory: "/workspace",
  parentID: "ses_parent",
  title: "opencode-smart-approval review",
  version: "1.17.14",
  time: { created: 10, updated: 11 },
};

describe("retained review child receipts", () => {
  test("requires one strict child and an identical exact-get Session identity", () => {
    // Given one flattened child list and exact-get response for the expected owned review session.
    const expected = {
      projectID: "project-id",
      directory: "/workspace",
      parentID: "ses_parent",
      title: "opencode-smart-approval review",
    };

    // When the retained boundary validates both source-runtime values together.
    const retained = parseRetainedChild([child], { ...child }, expected);

    // Then only the exact strict Session identity is retained.
    expect(retained).toEqual({ childID: "ses_child", parentID: "ses_parent", directory: "/workspace" });
  });

  test("rejects missing, duplicate, mismatched, or status-active retained children", () => {
    // Given every lookup or settled-status deviation from the pinned retained contract.
    const expected = {
      projectID: "project-id",
      directory: "/workspace",
      parentID: "ses_parent",
      title: "opencode-smart-approval review",
    };
    const calls = [
      () => parseRetainedChild([], child, expected),
      () => parseRetainedChild([child, child], child, expected),
      () => parseRetainedChild([child], { ...child, title: "other" }, expected),
      () => parseRetainedChild([child], { ...child, parentID: "ses_other" }, expected),
      () => requireRetainedStatusAbsent({ ses_child: { type: "idle" } }, "ses_child"),
    ];

    // When each value crosses the retained-session boundary.
    // Then every ambiguous or active result fails closed.
    for (const call of calls) expect(call).toThrow("sdk_malformed");
  });

  test("accepts only the revoked guarded-reader probe for the exact retained child", () => {
    // Given a completed retained-child tool call returning the product's revoked ownership result.
    const messages = [{
      info: { sessionID: "ses_child" },
      parts: [{
        type: "tool",
        tool: "opencode_smart_approval_read",
        state: {
          status: "completed",
          input: { path: "/workspace/review-nonce.txt", offset: 0 },
          output: "{\"ok\":false,\"error\":\"revoked\"}",
        },
      }],
    }];

    // When the probe receipt is parsed for the exact child and path.
    const receipt = parseRetainedReaderProbe(messages, "ses_child", "/workspace/review-nonce.txt");

    // Then no file content is accepted and the revoked result remains exact.
    expect(receipt).toEqual({ output: "{\"ok\":false,\"error\":\"revoked\"}" });
    expect(() => parseRetainedReaderProbe(messages, "ses_other", "/workspace/review-nonce.txt")).toThrow("sdk_malformed");
  });
});
