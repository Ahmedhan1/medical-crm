/**
 * Typed application errors. Every error carries an HTTP status and a stable
 * machine-readable `code` so the API can return consistent, non-leaky error
 * bodies and clients can branch on `code` rather than message strings.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, 'validation_error', message, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(401, 'unauthorized', message);
  }
}

/** Authenticated but lacking the required permission or out of data scope. */
export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action') {
    super(403, 'forbidden', message);
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(404, 'not_found', `${resource} not found`);
  }
}

/** Business-rule conflict, e.g. duplicate patient or active encounter exists. */
export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(409, 'conflict', message, details);
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
