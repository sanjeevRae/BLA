import { NextResponse } from "next/server";

import { AuthorizationError } from "@/lib/auth/actor";
import {
  ConflictError,
  DomainValidationError,
  NotFoundError,
  RateLimitError,
} from "@/lib/errors";

/**
 * The API error envelope (Phase 2 warehouses pattern):
 * `{ error: { code, message } }` with the domain error's HTTP status.
 * Returns null for errors that are not domain errors (caller rethrows).
 */
export function apiErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof AuthorizationError) {
    return NextResponse.json(
      { error: { code: "FORBIDDEN", message: error.message } },
      { status: 403 },
    );
  }
  if (error instanceof NotFoundError) {
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: error.message } },
      { status: 404 },
    );
  }
  if (error instanceof ConflictError) {
    return NextResponse.json(
      { error: { code: "CONFLICT", message: error.message } },
      { status: 409 },
    );
  }
  if (error instanceof DomainValidationError) {
    return NextResponse.json(
      { error: { code: "VALIDATION", message: error.message } },
      { status: 400 },
    );
  }
  if (error instanceof RateLimitError) {
    return NextResponse.json(
      { error: { code: "RATE_LIMITED", message: error.message } },
      { status: 429 },
    );
  }
  return null;
}

export function unauthenticatedResponse(): NextResponse {
  return NextResponse.json(
    { error: { code: "UNAUTHENTICATED", message: "Authentication required" } },
    { status: 401 },
  );
}
