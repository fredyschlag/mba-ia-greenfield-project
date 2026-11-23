import type { ThrottlerGetTrackerFunction } from '@nestjs/throttler';
import type { JwtPayload } from '../auth/auth.types';

const VIDEO_THROTTLE_TTL_MS = 60_000;

// JwtAuthGuard runs first, so video routes always have an authenticated user.
const trackByUser: ThrottlerGetTrackerFunction = (request) =>
  (request.user as JwtPayload).sub;

function perUserLimit(limit: number) {
  return {
    default: {
      limit,
      ttl: VIDEO_THROTTLE_TTL_MS,
      getTracker: trackByUser,
    },
  };
}

export const VIDEO_THROTTLES = {
  CREATE: perUserLimit(10),
  SIGN_PARTS: perUserLimit(60),
  LIST_PARTS: perUserLimit(30),
  COMPLETE: perUserLimit(10),
  GET: perUserLimit(120),
  PLAYBACK: perUserLimit(30),
  DOWNLOAD: perUserLimit(10),
} as const;
