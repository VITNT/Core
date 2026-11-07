import { error as kitError } from '@sveltejs/kit';
import { SOFFICE_PATH } from '$app/env/private';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { extension, MAX_FILE_SIZE, officeExtensions } from '#lib/files.ts';
import { findSoffice } from '#lib/server/office.ts';
import type { RequestHandler } from './$types';

const execute = promisify(execFile);
let active = 0;
function error(status: number, message: string): never { return kitError(status, message); }
function xml(value: string) { return value.replace(/[<>&"']/g, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[character]!); }

export const GET: RequestHandler = async () => Response.json({ available: Boolean(await findSoffice(SOFFICE_PATH)) });

export const POST: RequestHandler = async ({ request }) => {
  if (active >= 2) error(503, 'Document renderer is busy. Try again in a moment.');
  const soffice = await findSoffice(SOFFICE_PATH);
  if (!soffice) error(503, 'Office rendering needs LibreOffice on the app server. Install it, or export your document as a PDF.');
  // Bound multipart input even when Content-Length is absent or incorrect.
  const reader = request.body?.getReader();
  if (!reader) error(400, 'Choose a document first.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_FILE_SIZE + 1024 * 1024) { await reader.cancel(); error(413, 'Documents must be 50 MB or smaller.'); }
    chunks.push(value);
  }
  let form: FormData;
  try {
    form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': request.headers.get('content-type') ?? '' } }).formData();
  } catch { error(400, 'Invalid document upload.'); }
  const file = form.get('file');
  if (!(file instanceof File) || !file.size) error(400, 'Choose a non-empty document.');
  const ext = extension(file.name);
  if (!officeExtensions.includes(ext)) error(415, 'Supported documents: DOC, DOCX, ODT, RTF.');
  if (file.size > MAX_FILE_SIZE) error(413, 'Documents must be 50 MB or smaller.');
  if (active >= 2) error(503, 'Document renderer is busy. Try again in a moment.');
  active++;
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), 'khmer-ocr-'));
    const input = join(directory, `document.${ext}`);
    await writeFile(input, Buffer.from(await file.arrayBuffer()));
    const profile = pathToFileURL(join(directory, 'profile')).href;
    // Headless LibreOffice builds can miss system font directories. Supply our
    // Khmer font explicitly, while retaining system fonts for document fidelity.
    const fontConfig = join(directory, 'fonts.conf');
    await writeFile(fontConfig, `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd"><fontconfig>
      <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
      <include ignore_missing="yes">/opt/homebrew/etc/fonts/fonts.conf</include>
      <dir>${xml(resolve('server-assets/fonts'))}</dir>
      <dir>/usr/share/fonts</dir><dir>/usr/local/share/fonts</dir>
      <dir>/System/Library/Fonts</dir><dir>/Library/Fonts</dir><dir>~/Library/Fonts</dir>
      <cachedir>${xml(join(directory, 'font-cache'))}</cachedir>
    </fontconfig>`);
    await execute(soffice, [`-env:UserInstallation=${profile}`, '--headless', '--nologo', '--nodefault', '--norestore', '--convert-to', 'pdf', '--outdir', directory, input], {
      timeout: 60_000, maxBuffer: 1024 * 1024, signal: request.signal,
      env: { ...process.env, FONTCONFIG_FILE: fontConfig }
    });
    const output = join(directory, 'document.pdf');
    if ((await stat(output)).size > MAX_FILE_SIZE) error(413, 'Rendered document is too large. Export a smaller PDF and try again.');
    const pdf = await readFile(output);
    return new Response(pdf, { headers: { 'content-type': 'application/pdf', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
  } catch (cause) {
    if (cause && typeof cause === 'object' && 'status' in cause) throw cause;
    console.error('Office rendering failed:', cause instanceof Error ? cause.message : 'Unknown error');
    error(422, 'Could not render this document. It may be damaged or password-protected. Try exporting it as a PDF.');
  } finally {
    active--;
    if (directory) await rm(directory, { recursive: true, force: true });
  }
};
