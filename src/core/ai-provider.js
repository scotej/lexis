/** Route credentials locally; never probe a second provider with a failed key. */
export function aiProvider(settings) {
  const key = String(typeof settings === "string" ? settings : settings?.key ?? "").trim();
  return /^sk-(?!or-)/.test(key) ? "openai" : "openrouter";
}

export function aiProviderName(settings) {
  return aiProvider(settings) === "openai" ? "OpenAI" : "OpenRouter";
}

export function defaultAiModel(settings) {
  return aiProvider(settings) === "openai" ? "gpt-5.4-mini" : "openrouter/auto";
}
