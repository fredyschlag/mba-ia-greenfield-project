import { registerAs } from '@nestjs/config';

export const DEFAULT_VIDEO_MAX_UPLOAD_BYTES = 10_737_418_240;

export default registerAs('video', () => ({
  maxUploadBytes: parseInt(
    process.env.VIDEO_MAX_UPLOAD_BYTES ??
      String(DEFAULT_VIDEO_MAX_UPLOAD_BYTES),
    10,
  ),
}));
