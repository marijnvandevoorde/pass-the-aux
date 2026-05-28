/** Extensions the library treats as playable tracks (domain knowledge). */
export const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
  ".mp3",
  ".wav",
  ".flac",
  ".ogg",
  ".m4a",
  ".aac",
  ".opus",
]);

export function isAudioExtension(ext: string): boolean {
  return AUDIO_EXTENSIONS.has(ext.toLowerCase());
}
