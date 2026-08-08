import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { RequestContextStore } from '../context/request-context';

/**
 * RFC 7807 problem+json responses.
 *
 * Two rules that matter more here than in a typical API:
 *   - Internal error detail never reaches the client. A stack trace or a raw
 *     database message can disclose schema, and in this domain it can disclose
 *     patient data.
 *   - Every response carries the request id, so a lab can report "request
 *     abc-123 failed" and it is findable in the logs without them describing
 *     what they were doing with a patient.
 */
@Catch()
export class ProblemDetailFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request>();
    const requestId = RequestContextStore.get()?.requestId;

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let title = 'Internal Server Error';
    let detail: string | undefined;
    let errors: Record<string, string[]> | undefined;

    if (exception instanceof ZodError) {
      status = HttpStatus.UNPROCESSABLE_ENTITY;
      title = 'Validation Failed';
      detail = 'One or more fields are invalid';
      errors = {};
      for (const issue of exception.issues) {
        const path = issue.path.join('.') || '_';
        (errors[path] ??= []).push(issue.message);
      }
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      title = exception.name.replace(/Exception$/, '').replace(/([a-z])([A-Z])/g, '$1 $2');

      if (typeof body === 'string') {
        detail = body;
      } else if (body && typeof body === 'object') {
        const b = body as { message?: unknown; error?: unknown };
        detail = Array.isArray(b.message) ? b.message.join('; ') : String(b.message ?? b.error ?? '');
      }
    } else if (isPrismaKnownError(exception)) {
      const mapped = mapPrismaError(exception);
      status = mapped.status;
      title = mapped.title;
      detail = mapped.detail;
    }

    if (status >= 500) {
      // Full detail to the log, never to the client.
      this.logger.error(
        `${req.method} ${req.url} -> ${status} [${requestId}]`,
        exception instanceof Error ? exception.stack : String(exception),
      );
      detail = 'An unexpected error occurred. Quote the request id when reporting this.';
    }

    res.status(status).type('application/problem+json').json({
      type: `https://docs.labsetu.in/errors/${slug(title)}`,
      title,
      status,
      detail,
      instance: req.url,
      requestId,
      errors,
    });
  }
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function isPrismaKnownError(e: unknown): e is { code: string; meta?: Record<string, unknown> } {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    typeof (e as { code: unknown }).code === 'string' &&
    (e as { code: string }).code.startsWith('P')
  );
}

function mapPrismaError(e: { code: string; meta?: Record<string, unknown> }): {
  status: number;
  title: string;
  detail: string;
} {
  switch (e.code) {
    case 'P2002': {
      const target = Array.isArray(e.meta?.target) ? (e.meta.target as string[]).join(', ') : 'field';
      return {
        status: HttpStatus.CONFLICT,
        title: 'Conflict',
        detail: `A record with this ${target} already exists`,
      };
    }
    case 'P2025':
      return { status: HttpStatus.NOT_FOUND, title: 'Not Found', detail: 'The record was not found' };
    case 'P2003':
      return {
        status: HttpStatus.BAD_REQUEST,
        title: 'Bad Request',
        detail: 'A referenced record does not exist',
      };
    case 'P2028':
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        title: 'Service Unavailable',
        detail: 'The request took too long and was rolled back. Please retry.',
      };
    default:
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        title: 'Internal Server Error',
        detail: 'A database error occurred',
      };
  }
}
