import { PipeTransform, Injectable, ArgumentMetadata } from '@nestjs/common';
import { ZodSchema } from 'zod';

/**
 * Validates against a schema from @labsetu/contracts — the same schema the web
 * app uses for its forms, so client and server validation cannot drift apart.
 *
 * Parsing (not just checking) also means the handler receives the transformed
 * value: phone numbers normalised to +91XXXXXXXXXX, dates coerced, strings
 * trimmed. Normalisation at the boundary is what keeps blind indexes matching.
 *
 * ALWAYS bind at the parameter level:
 *
 *     create(@Body(zodPipe(schema)) body: T)          // correct
 *     @UsePipes(zodPipe(schema)) create(@Param() id)  // WRONG
 *
 * `@UsePipes` applies the pipe to EVERY handler argument, so on a route like
 * POST /tests/:id/results it would also run the route param through the body
 * schema and reject a perfectly valid request with a confusing 422.
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodSchema) {}

  transform(value: unknown, _metadata: ArgumentMetadata): unknown {
    // Throws ZodError, which ProblemDetailFilter renders as a 422 with
    // per-field messages.
    return this.schema.parse(value);
  }
}

export const zodPipe = (schema: ZodSchema) => new ZodValidationPipe(schema);
