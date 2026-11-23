import { extname } from 'node:path';
import {
  DOWNLOAD_FILENAME_FALLBACK,
  DOWNLOAD_FILENAME_MAX_LENGTH,
} from './videos.constants';

function limitLength(name: string): string {
  const characters = [...name];
  if (characters.length <= DOWNLOAD_FILENAME_MAX_LENGTH) {
    return name;
  }
  const extension = [...extname(name)];
  const baseLength = DOWNLOAD_FILENAME_MAX_LENGTH - extension.length;
  if (baseLength <= 0) {
    return characters.slice(0, DOWNLOAD_FILENAME_MAX_LENGTH).join('');
  }
  return [...characters.slice(0, baseLength), ...extension].join('');
}

function sanitizeFilename(filename: string): string {
  const cleaned = filename
    .replace(/\p{Cc}/gu, '')
    .replace(/[/\\]/g, '_')
    .replace(/["*:<>?|;]/g, '')
    .trim()
    .replace(/^\.+/, '');
  return limitLength(cleaned) || DOWNLOAD_FILENAME_FALLBACK;
}

function toAsciiFilename(filename: string): string {
  return filename
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^A-Za-z0-9._ -]/g, '_');
}

function encodeExtendedValue(filename: string): string {
  return encodeURIComponent(filename).replace(
    /['()*]/g,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  );
}

/** Builds an RFC 6266 `attachment` value from a name supplied by the user. */
export function buildAttachmentDisposition(filename: string): string {
  const safeName = sanitizeFilename(filename);
  return `attachment; filename="${toAsciiFilename(safeName)}"; filename*=UTF-8''${encodeExtendedValue(safeName)}`;
}
