// TTS is now handled client-side via browser SpeechSynthesis API (see utils/speechUtils.ts).
// AI chat responses come from the Perplexity Sonar API via the /api/chat server endpoint.
// This file is kept for backward compatibility but exports are no longer used.

export async function getChatResponse(_agentPrompt: string, _history: { role: "user" | "model", parts: { text: string }[] }[]): Promise<string> {
  return "Chat is handled server-side via Perplexity API.";
}

export async function generateAudio(_text: string, _voiceName: string = 'default'): Promise<string | undefined> {
  return undefined;
}
