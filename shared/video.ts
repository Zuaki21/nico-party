/** URL や文字列から sm9 / so123 / nm456 形式の動画 ID を取り出す */
export function parseVideoId(input: string): string | null {
  return input.match(/\b(?:sm|so|nm)\d{1,10}\b/)?.[0] ?? null;
}
