export const S3_INTERNAL_CLIENT = Symbol('S3_INTERNAL_CLIENT');
export const S3_PRESIGN_CLIENT = Symbol('S3_PRESIGN_CLIENT');

export const UPLOAD_PART_URL_TTL_SECONDS = 3600;
export const LIST_PARTS_PAGE_SIZE = 1000;

export const S3_MISSING_RESOURCE_ERRORS = [
  'NoSuchUpload',
  'NoSuchKey',
  'NotFound',
] as const;
