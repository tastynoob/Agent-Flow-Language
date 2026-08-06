import {
  PiAgentExecutorBackend,
  createPiCodingAgentBinding,
} from "@afl-lang/core";

const provider = requiredEnvironment("AFL_PI_PROVIDER");
const model = requiredEnvironment("AFL_PI_MODEL");

export default {
  agentExecutor: new PiAgentExecutorBackend({
    defaultBinding: createPiCodingAgentBinding({
      model: { provider, id: model },
    }),
  }),
};

function requiredEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}
