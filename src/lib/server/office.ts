import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join } from 'node:path';

export async function findSoffice(override?: string) {
  const candidates = [override, '/Applications/LibreOffice.app/Contents/MacOS/soffice', '/usr/bin/soffice', '/usr/bin/libreoffice',
    ...(process.env.PATH ?? '').split(delimiter).map((directory) => join(directory, process.platform === 'win32' ? 'soffice.exe' : 'soffice'))];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* Try the next standard install location. */ }
  }
  return null;
}
