/** The directory extension processes may read, besides their own package. */
export declare const RUNTIME_DIR: string;
/** The child's entry point. */
export declare const MAIN_PATH: string;

/** The largest message either side accepts, in bytes. */
export declare const MAX_FRAME_BYTES: number;
/** Request and response bodies are capped at this size. */
export declare const MAX_BODY_BYTES: number;
/** WebSocket messages are capped at this size in both directions. */
export declare const MAX_SOCKET_MESSAGE_BYTES: number;

export declare class FrameError extends Error {}

/** Serializes one message with its length header. Throws when it's over the limit or can't be cloned. */
export declare function encodeFrame(message: unknown, maxBytes?: number): Buffer;

/** Splits a byte stream back into messages. */
export declare class FrameDecoder {
  constructor(maxBytes?: number);
  /** Returns every message the bytes complete. Throws a FrameError on an oversized header. */
  push(chunk: Buffer): unknown[];
}

export interface WireError {
  name: string;
  message: string;
  code?: string;
  retryable?: boolean;
  permission?: string;
  resource?: string;
}

export declare function toWireError(err: unknown): WireError;

/** Requests in both directions over one channel. */
export declare class Peer {
  constructor(opts: {
    send: (frame: Record<string, unknown>) => void;
    onRequest: (method: string, params: unknown, signal: AbortSignal) => Promise<unknown>;
    onNote: (method: string, params: unknown) => void;
    toError: (err: WireError) => unknown;
  });
  readonly pendingCount: number;
  readonly incomingCount: number;
  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
  notify(method: string, params: unknown): void;
  /** Handles one frame. Returns false for frames it doesn't know. */
  handle(frame: unknown): boolean;
  /** Rejects every pending request and aborts every incoming one. */
  close(error: unknown): void;
}
