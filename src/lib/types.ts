export type OcrOptions = {
  language: 'khm' | 'khm+eng' | 'eng';
  quality: 'best' | 'fast';
  dpi: 200 | 300;
  enhance: boolean;
  layout: 'auto' | 'column';
};

export type PageResult = { number: number; text: string; originalText?: string; reviewWords?: string[]; confidence: number; preview: string };
export type DocumentJob = {
  id: string;
  file: File;
  status: 'queued' | 'processing' | 'done' | 'error' | 'cancelled';
  progress: number;
  stage: string;
  pages: PageResult[];
  error?: string;
};

export const defaultOptions: OcrOptions = {
  language: 'khm+eng', quality: 'best', dpi: 300, enhance: true, layout: 'auto'
};
