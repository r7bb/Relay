/**
 * Errors that are safe to surface to a client. Anything else that escapes a
 * handler is logged and reported as a generic 500, so internal details -- SQL
 * text, stack traces, driver messages -- never reach the response body.
 */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static badRequest(message: string, code = 'bad_request') {
    return new ApiError(400, code, message);
  }

  static unauthorized(message = 'Authentication required') {
    return new ApiError(401, 'unauthorized', message);
  }

  static forbidden(message = 'You do not have permission to do that') {
    return new ApiError(403, 'forbidden', message);
  }

  /**
   * Also used where 403 would be the literal truth but would confirm that a
   * resource exists. See `requireMembership`.
   */
  static notFound(message = 'Not found') {
    return new ApiError(404, 'not_found', message);
  }

  static conflict(message: string, code = 'conflict') {
    return new ApiError(409, code, message);
  }
}
