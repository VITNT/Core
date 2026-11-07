type Reading = { text: string; confidence: number };
const characters = (text: string) => text.match(/[\p{L}\p{N}\p{M}]/gu)?.length ?? 0;
const scriptCount = (text: string, script: RegExp) => text.match(script)?.length ?? 0;

export function needsSecondPass(reading: Reading) {
  return !reading.text.trim() || !Number.isFinite(reading.confidence) || reading.confidence < 75;
}

export function preferReading<T extends Reading>(first: T, alternative: T): T {
  if (!Number.isFinite(alternative.confidence)) return first;
  const before = characters(first.text), after = characters(alternative.text);
  if (before === 0) return after >= 4 && alternative.confidence >= 60 ? alternative : first;
  const confidence = Number.isFinite(first.confidence) ? first.confidence : 0;
  if (after < before * 0.85 || after > before * 1.5 || alternative.confidence < Math.max(60, confidence + 5)) return first;
  // A higher average score can hide omitted text. Preserve both scripts in
  // bilingual pages instead of rewarding a short, confident partial reading.
  for (const script of [/\p{Script=Khmer}/gu, /\p{Script=Latin}/gu]) {
    if (scriptCount(alternative.text, script) < scriptCount(first.text, script) * 0.85) return first;
  }
  return alternative;
}
