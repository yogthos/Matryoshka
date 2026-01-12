import type { LLMProvider, LLMConfig, ProviderConfig } from "./types.js";

export function createOllamaProvider(config: ProviderConfig): LLMProvider {
  return {
    name: "ollama",

    async query(prompt: string, llmConfig: LLMConfig): Promise<string> {
      const response = await fetch(`${config.baseUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: llmConfig.model,
          prompt,
          stream: false,
          options: {
            temperature: llmConfig.options?.temperature ?? 0.2,
            num_ctx: llmConfig.options?.num_ctx ?? 8192,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(
          `Ollama error: ${response.status} ${response.statusText}`
        );
      }

      const data = (await response.json()) as { response?: string };
      if (!data.response) {
        throw new Error("Ollama returned empty response");
      }
      return data.response;
    },
  };
}
