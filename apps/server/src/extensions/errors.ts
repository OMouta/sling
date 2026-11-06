/** A refusal to show the person who asked, with the HTTP status to send. */
export class ExtensionError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ExtensionError";
    this.status = status;
  }
}
