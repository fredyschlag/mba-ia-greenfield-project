import { ArgumentsHost } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { ThrottlerExceptionFilter } from './throttler-exception.filter';

describe('ThrottlerExceptionFilter', () => {
  let filter: ThrottlerExceptionFilter;
  let mockJson: jest.Mock;
  let mockStatus: jest.Mock;
  let mockHost: ArgumentsHost;

  beforeEach(() => {
    filter = new ThrottlerExceptionFilter();
    mockJson = jest.fn();
    mockStatus = jest.fn().mockReturnValue({ json: mockJson });

    mockHost = {
      switchToHttp: () => ({
        getResponse: () => ({ status: mockStatus }),
      }),
    } as unknown as ArgumentsHost;
  });

  it('should map the default exception to the error envelope', () => {
    filter.catch(new ThrottlerException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(429);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 429,
      error: 'TOO_MANY_REQUESTS',
      message: 'ThrottlerException: Too Many Requests',
    });
  });

  it('should keep a custom throttler message', () => {
    filter.catch(new ThrottlerException('Slow down'), mockHost);

    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 429,
      error: 'TOO_MANY_REQUESTS',
      message: 'Slow down',
    });
  });
});
