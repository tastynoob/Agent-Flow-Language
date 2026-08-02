import { OpenAICompatibleAgentAdapter } from "../dist/src/index.js";

const apiKey = process.env.DEEPSEEK_API_KEY;
if (apiKey === undefined || apiKey.length === 0) {
  throw new Error("DEEPSEEK_API_KEY is required");
}

const model = process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";
const binding = { model, maxTokens: 512 };

export default {
  agents: new OpenAICompatibleAgentAdapter({
    baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
    apiKey: () => process.env.DEEPSEEK_API_KEY ?? "",
    agents: {
      "@agent.smoke": binding,
      "@agent.coder": binding,
      "@agent.reviewer": binding,
    },
  }),
};
