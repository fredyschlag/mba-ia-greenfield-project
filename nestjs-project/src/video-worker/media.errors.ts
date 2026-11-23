/** The file itself cannot be used: retrying would produce the same result. */
export class MediaUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaUnreadableError';
  }
}

/** Network, storage or process failure: the job can be retried. */
export class MediaToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaToolError';
  }
}
