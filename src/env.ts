import { defineEnvVars } from '@sveltejs/kit/env';

export const variables = defineEnvVars({
  SOFFICE_PATH: { schema: (value: string | undefined) => value, description: 'Optional LibreOffice executable path.' }
});
