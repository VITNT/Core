const imageTypes: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/x-ms-bmp': 'bmp',
};

export function pastedImages(data: Pick<DataTransfer, 'items'>): File[] {
  return Array.from(data.items).flatMap((item) => {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) return [];
    const file = item.getAsFile();
    if (!file) return [];
    const suffix = imageTypes[file.type] ?? 'unsupported';
    // Clipboard screenshots often have generic or missing filenames. Give each
    // paste a unique name so separate screenshots don't collide in the queue.
    return [new File([file], `pasted-image-${crypto.randomUUID()}.${suffix}`, {
      type: file.type,
      lastModified: file.lastModified,
    })];
  });
}
