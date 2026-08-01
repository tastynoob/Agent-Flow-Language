import {
  defineProgram,
  expression as e,
  node as n,
  schema as s,
  target as t,
} from "../dist/src/index.js";

export { defineProgram, e, n, s, t };

export const anyAgentOperation = {
  input: s.any(),
  output: s.any(),
};

export function oneFlowProgram(flow, agents = {}) {
  return defineProgram({
    irVersion: "0.1",
    name: "test-program",
    entry: "main",
    agents,
    flows: { main: flow },
  });
}
