import type { LLMProvider, LLMConfig, ProviderConfig } from "./types.js";

interface ChatCompletionResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

export function createDeepSeekProvider(config: ProviderConfig): LLMProvider {
  return {
    name: "deepseek",

    async query(prompt: string, llmConfig: LLMConfig): Promise<string> {
      if (!config.apiKey) {
        throw new Error("DeepSeek API key not configured");
      }

      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: llmConfig.model,
          messages: [{ role: "user", content: prompt }],
          temperature: llmConfig.options?.temperature ?? 0.2,
          max_tokens: llmConfig.options?.max_tokens ?? 4096,
        }),
      });

      if (!response.ok) {
        throw new Error(
          `DeepSeek error: ${response.status} ${response.statusText}`
        );
      }

      const data = (await response.json()) as ChatCompletionResponse;
      if (!data.choices || data.choices.length === 0) {
        throw new Error("DeepSeek returned empty response (no choices)");
      }
      return data.choices[0].message.content;
    },
  };
}
