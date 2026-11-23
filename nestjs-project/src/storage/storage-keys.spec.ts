import { videoSourceKey, videoThumbnailKey } from './storage-keys';

describe('storage keys', () => {
  const videoId = '6f1f7a2e-52f1-4f0f-9c44-7b7f9f4a2c10';

  it('should build the source key from the video id', () => {
    expect(videoSourceKey(videoId)).toBe(`videos/${videoId}/source`);
  });

  it('should build the thumbnail key from the video id', () => {
    expect(videoThumbnailKey(videoId)).toBe(`videos/${videoId}/thumbnail.jpg`);
  });

  it('should depend only on the video id', () => {
    expect(videoSourceKey.length).toBe(1);
    expect(videoThumbnailKey.length).toBe(1);
  });
});
