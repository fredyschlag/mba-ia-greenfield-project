import { DomainException } from '../common/exceptions/domain.exception';

export class ChannelNotFoundException extends DomainException {
  constructor() {
    super('CHANNEL_NOT_FOUND', 404, 'Channel not found');
  }
}

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoTooLargeException extends DomainException {
  constructor() {
    super('VIDEO_TOO_LARGE', 413, 'Video exceeds the maximum upload size');
  }
}

export class ActiveUploadLimitReachedException extends DomainException {
  constructor() {
    super(
      'ACTIVE_UPLOAD_LIMIT_REACHED',
      409,
      'Channel reached the limit of active uploads',
    );
  }
}

export class InvalidPartNumberException extends DomainException {
  constructor() {
    super('INVALID_PART_NUMBER', 400, 'Part number exceeds the part count');
  }
}

export class UploadNotActiveException extends DomainException {
  constructor() {
    super('UPLOAD_NOT_ACTIVE', 409, 'Video upload is not active');
  }
}

export class UploadExpiredException extends DomainException {
  constructor() {
    super('UPLOAD_EXPIRED', 410, 'Upload session has expired');
  }
}

export class UploadIncompleteException extends DomainException {
  constructor() {
    super(
      'UPLOAD_INCOMPLETE',
      409,
      'Uploaded parts do not match the declared file',
    );
  }
}

export class VideoSizeMismatchException extends DomainException {
  constructor() {
    super(
      'VIDEO_SIZE_MISMATCH',
      422,
      'Stored video size does not match the declared size',
    );
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video is not ready');
  }
}
