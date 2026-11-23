import { generateVideoSlug, isValidVideoSlug } from './video-slug.util';

describe('video slug', () => {
  it('should generate 11 base62 characters', () => {
    for (let index = 0; index < 200; index += 1) {
      expect(generateVideoSlug()).toMatch(/^[0-9A-Za-z]{11}$/);
    }
  });

  it('should generate different slugs', () => {
    const slugs = new Set(
      Array.from({ length: 1_000 }, () => generateVideoSlug()),
    );

    expect(slugs.size).toBe(1_000);
  });

  it('should accept a generated slug', () => {
    expect(isValidVideoSlug(generateVideoSlug())).toBe(true);
  });

  it.each(['short', 'aZ3kP9xQ1bCD', 'aZ3kP9xQ1b-', 'aZ3kP9xQ1b ', ''])(
    'should reject the malformed slug "%s"',
    (slug) => {
      expect(isValidVideoSlug(slug)).toBe(false);
    },
  );
});
