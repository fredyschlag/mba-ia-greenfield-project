import type { MigrationInterface } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import { CreateUsersAndChannels1775687773260 } from '../database/migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from '../database/migrations/1777579850478-CreateAuthTokens';
import { CreateVideos1795397950590 } from '../database/migrations/1795397950590-CreateVideos';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';

// TypeORM installs uuid-ossp on connect only when it sees entities with
// generated UUID columns, and the migrations depend on that extension.
export const ALL_ENTITIES = [
  User,
  Channel,
  RefreshToken,
  VerificationToken,
  Video,
];

// Lives outside src/database/migrations so the data-source glob never loads it.
export const ALL_MIGRATIONS: (new () => MigrationInterface)[] = [
  CreateUsersAndChannels1775687773260,
  CreateAuthTokens1777579850478,
  CreateVideos1795397950590,
];
