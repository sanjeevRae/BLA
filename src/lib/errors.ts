/**
 * Domain error types thrown by the service layer and translated by
 * Server Actions / Route Handlers into error results
 * (docs/security-architecture.md §3.4). Authentication (401) and
 * Authorization (403) errors live in src/lib/auth/actor.ts.
 */

export class NotFoundError extends Error {
  readonly status = 404;
  constructor(message = "Resource not found") {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  readonly status = 409;
  constructor(message = "Conflict") {
    super(message);
    this.name = "ConflictError";
  }
}

/** The request was understood but violates a business rule (HTTP 400). */
export class DomainValidationError extends Error {
  readonly status = 400;
  constructor(message = "Validation failed") {
    super(message);
    this.name = "DomainValidationError";
  }
}

/** The caller is sending faster than the allowed rate (HTTP 429). */
export class RateLimitError extends Error {
  readonly status = 429;
  constructor(message = "Too many requests") {
    super(message);
    this.name = "RateLimitError";
  }
}
