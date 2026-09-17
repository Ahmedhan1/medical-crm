/** The backend's error envelope: `{ error: { code, message, details?, request_id } }`. */
export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: unknown;
    request_id?: string;
  };
}

/**
 * Normalized client-side error. Domain components catch THIS, never a raw
 * Response or fetch error, so backend implementation details never leak into
 * product code. `requestId` lets support correlate a failure to a server log.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly requestId?: string;

  constructor(args: {
    status: number;
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
  }) {
    super(args.message);
    this.name = 'ApiError';
    this.status = args.status;
    this.code = args.code;
    this.details = args.details;
    this.requestId = args.requestId;
  }

  /** True when the request was cancelled (AbortController) — not a real failure. */
  get isCancelled(): boolean {
    return this.code === 'cancelled';
  }
  get isUnauthorized(): boolean {
    return this.status === 401;
  }
  get isForbidden(): boolean {
    return this.status === 403;
  }
  /** Zod/validation field errors, when the backend returned them. */
  get validationDetails(): unknown {
    return this.code === 'validation_error' ? this.details : undefined;
  }
}
