import {
  defineProgram,
  expression as e,
  node as n,
  schema as s,
  target as t,
} from "../src/index.js";

const review = s.object(
  {
    status: s.enum(["accepted", "revision_required", "blocked"]),
    issues: s.array(s.string()),
  },
  { required: ["status", "issues"], additionalProperties: false },
);

export const coderReviewer = defineProgram({
  irVersion: "0.1",
  name: "coder-reviewer",
  entry: "main",
  agents: {
    coder: {
      capabilities: ["code.write"],
      operations: {
        implement: { input: s.string(), output: s.string() },
        revise: {
          input: s.object(
            { artifact: s.string(), issues: s.array(s.string()) },
            { required: ["artifact", "issues"], additionalProperties: false },
          ),
          output: s.string(),
        },
      },
    },
    reviewer: {
      capabilities: ["code.review"],
      operations: {
        review: { input: s.string(), output: review },
      },
    },
  },
  flows: {
    main: {
      input: s.object(
        { task: s.string() },
        { required: ["task"], additionalProperties: false },
      ),
      output: s.string(),
      state: {
        artifact: { schema: s.string(), initial: "" },
        review: {
          schema: review,
          initial: { status: "revision_required", issues: ["not reviewed"] },
        },
      },
      body: n.sequence("main", [
        n.invoke(
          "implement",
          "coder",
          "implement",
          e.input("task"),
          t.state("artifact"),
        ),
        n.loop(
          "review-loop",
          e.binary("neq", e.state("review", ["status"]), e.literal("accepted")),
          n.sequence("review-iteration", [
            n.invoke(
              "review",
              "reviewer",
              "review",
              e.state("artifact"),
              t.state("review"),
            ),
            n.branch("review-result", [
              {
                when: e.binary(
                  "eq",
                  e.state("review", ["status"]),
                  e.literal("revision_required"),
                ),
                then: n.invoke(
                  "revise",
                  "coder",
                  "revise",
                  e.object({
                    artifact: e.state("artifact"),
                    issues: e.state("review", ["issues"]),
                  }),
                  t.state("artifact"),
                ),
              },
              {
                when: e.binary(
                  "eq",
                  e.state("review", ["status"]),
                  e.literal("blocked"),
                ),
                then: n.fail(
                  "blocked",
                  e.object({
                    code: e.literal("REVIEW_BLOCKED"),
                    message: e.literal("reviewer cannot make a decision"),
                    details: e.state("review"),
                  }),
                ),
              },
            ]),
          ]),
          5,
        ),
        n.return("return-artifact", e.state("artifact")),
      ]),
    },
  },
});
