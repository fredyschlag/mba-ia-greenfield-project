import { applyDecorators } from '@nestjs/common';
import { ApiResponse, getSchemaPath } from '@nestjs/swagger';
import { ApiErrorEnvelope } from './api-error-envelope.dto';

/** Documents one error status using the shared error envelope. */
export function ApiErrorResponse(
  status: number,
  description: string,
): MethodDecorator & ClassDecorator {
  return applyDecorators(
    ApiResponse({
      status,
      description,
      schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
    }),
  );
}
