export const officeExtensions = ['doc', 'docx', 'odt', 'rtf'];
export const imageExtensions = ['png', 'jpg', 'jpeg', 'webp', 'bmp'];
export const supportedExtensions = ['pdf', ...officeExtensions, ...imageExtensions];
export const MAX_FILE_SIZE = 50 * 1024 * 1024;
export const MAX_PAGES = 200;
export const acceptFiles = supportedExtensions.map((extension) => `.${extension}`).join(',');

export function extension(name: string) { return name.split('.').pop()?.toLowerCase() ?? ''; }
export function fileError(file: { name: string; size: number }): string | null {
  if (!supportedExtensions.includes(extension(file.name))) return `${file.name}: unsupported file type.`;
  if (!file.size) return `${file.name}: the file is empty.`;
  if (file.size > MAX_FILE_SIZE) return `${file.name}: exceeds the 50 MB limit.`;
  return null;
}
export function formatBytes(bytes: number) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
export function textFilename(name: string) { return `${name.replace(/\.[^.]+$/, '')}.txt`; }
export function joinPages(pages: { text: string }[]) { return pages.map((page) => page.text.trim()).join('\n\n'); }
