import type { TelegramSettings } from "../../utils/settings";
import { getApiKey, getBaseURL, resolveTelegramAudioInputSettings } from "../../utils/settings";
import { CrowSttEngine, type CrowSttTranscriptionResult } from "./crow-stt";

export interface AudioTranscriptionInput {
  audioPath: string;
  fileName?: string;
  mimeType?: string;
}

export type AudioTranscriptionResult = CrowSttTranscriptionResult;

export interface AudioTranscriptionEngine {
  transcribe(input: AudioTranscriptionInput): Promise<AudioTranscriptionResult>;
}

export function createTelegramAudioInputEngine(
  telegramSettings: TelegramSettings | undefined,
): AudioTranscriptionEngine {
  const resolved = resolveTelegramAudioInputSettings(telegramSettings);
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error(
      "Grok STT requires an API key. Set GROK_API_KEY or configure apiKey in ~/.crow/user-settings.json.",
    );
  }

  return new CrowSttEngine({
    apiKey,
    baseURL: getBaseURL(),
    language: resolved.language,
  });
}
