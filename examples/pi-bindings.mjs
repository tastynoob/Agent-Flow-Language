import {
  defineBindings,
  pi,
} from "@afl-lang/core";

const provider = requiredEnvironment("AFL_PI_PROVIDER");
const model = requiredEnvironment("AFL_PI_MODEL");

export default defineBindings({
  agents: pi({ model: `${provider}/${model}` }),
});

function requiredEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}
