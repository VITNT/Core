// Restrict cleanup to isolated, implausible symbol/number tokens. Do not blacklist
// punctuation in Tesseract: Khmer marks, prices, references and formulas need it.
const noiseSymbols = /[#$@%^&*~|\\`]/gu;
const noiseToken = /^[\p{N}#$@%^&*~|\\`()[\]{}.,:;!?"'“”‘’]+$/u;

export function cleanOcrText(rawText: string): string {
  return rawText.normalize('NFC').split('\n').map((line) => {
    let changed = false;
    const cleaned = line.replace(/(\S+)([^\S\r\n]*)/gu, (match, token: string) => {
      const symbols = token.match(noiseSymbols) ?? [];
      // Three or more symbols of different kinds distinguish #10#$ / @#$ from
      // ordinary #10, $10, 10%, C#, repeated separators, and math operators.
      if (!noiseToken.test(token) || symbols.length < 3 || new Set(symbols).size < 2) return match;
      // Numeric formulas can legitimately mix currency and operators. Require
      // a non-mathematical noise character before discarding numeric content.
      if (/\p{N}/u.test(token) && !/[#@\\`]/u.test(token)) return match;
      changed = true;
      return '';
    });
    // Keep indentation, columns, blank lines and line endings in untouched text.
    return changed ? cleaned.replace(/[^\S\r\n]+(?=\r?$)/u, '') : cleaned;
  }).join('\n');
}
