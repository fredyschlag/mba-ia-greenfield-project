import { randomInt } from 'node:crypto';
import { VIDEO_SLUG_ALPHABET, VIDEO_SLUG_LENGTH } from './videos.constants';

const VIDEO_SLUG_PATTERN = new RegExp(`^[0-9A-Za-z]{${VIDEO_SLUG_LENGTH}}$`);

export function generateVideoSlug(): string {
  let slug = '';
  for (let index = 0; index < VIDEO_SLUG_LENGTH; index += 1) {
    slug += VIDEO_SLUG_ALPHABET[randomInt(VIDEO_SLUG_ALPHABET.length)];
  }
  return slug;
}

export function isValidVideoSlug(slug: string): boolean {
  return VIDEO_SLUG_PATTERN.test(slug);
}
