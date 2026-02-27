import { GoogleGenAI, Modality } from "@google/genai";
import { GLOBAL_SYSTEM_PROMPT } from "../constants/prompts";

const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export async function getChatResponse(agentPrompt: string, history: { role: "user" | "model", parts: { text: string }[] }[]) {
  const model = "gemini-3-flash-preview";
  
  const response = await genAI.models.generateContent({
    model,
    contents: history,
    config: {
      systemInstruction: `${GLOBAL_SYSTEM_PROMPT}\n\nCURRENT AGENT CONTEXT:\n${agentPrompt}`,
      temperature: 0.7,
    },
  });

  return response.text || "I'm sorry, I'm having trouble connecting. Please try again.";
}

export async function generateAudio(text: string, voiceName: 'Puck' | 'Charon' | 'Kore' | 'Fenrir' | 'Zephyr' = 'Kore') {
  const response = await genAI.models.generateContent({
    model: "gemini-2.5-flash-preview-tts",
    contents: [{ parts: [{ text }] }],
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName },
        },
      },
    },
  });

  const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  return base64Audio;
}
