import type { SupportedVoiceName } from "./voices";

export const FIXED_SPEED = 1.0 as const;

export function voiceRelativePath(voice: SupportedVoiceName): string {
  return `model/voices/${voice}.bin`;
}
