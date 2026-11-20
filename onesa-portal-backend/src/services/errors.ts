/** Shared HTTP error type without application environment or database side effects. */
export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}
