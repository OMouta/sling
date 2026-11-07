import type { FileReadResult, FileSearchResult } from "@sling/runner-protocol";
import type { AppContext } from "../context.ts";
import type { RunnerSession } from "../runners/gateway.ts";

/** Most hits one search returns. */
export const FILE_SEARCH_MAX = 50;
/** Most of a file one read returns. */
export const FILE_READ_MAX_BYTES = 256 * 1024;

export interface FileHit {
  machine: string;
  folder: string;
  /** Relative to the folder. */
  path: string;
  line: number;
  snippet: string;
}

export interface FileSearchAnswer {
  hits: FileHit[];
  /** More hits than it returned, or a machine ran out of time. */
  truncated: boolean;
  /** Machines that couldn't search, and why, such as being offline or having `files off`. */
  errors: { machine: string; error: string }[];
}

export interface FileReadAnswer {
  machine: string;
  folder: string;
  path: string;
  content: string;
  truncated: boolean;
  /** The whole file's size in bytes. */
  size: number;
}

/** Why a search or a read didn't happen, in words for the assistant. */
export class FileError extends Error {}

export interface FileService {
  /**
   * Searches shared folders: on one machine when `machine` is set, or on
   * every online machine that shares any. `folder` narrows it to one.
   */
  search(
    workspaceId: string,
    opts: {
      query: string;
      machine?: string;
      folder?: string;
      maxResults?: number;
      signal?: AbortSignal;
    },
  ): Promise<FileSearchAnswer>;
  /** Reads one text file in a shared folder. Throws FileError with what the machine said. */
  read(
    workspaceId: string,
    opts: { machine: string; folder: string; path: string; signal?: AbortSignal },
  ): Promise<FileReadAnswer>;
  /** A machine's answer to a FileSearch. */
  searchResult(session: RunnerSession, result: FileSearchResult): void;
  /** A machine's answer to a FileRead. */
  readResult(session: RunnerSession, result: FileReadResult): void;
}

/** Files in the folders machines share. Until it's built every search and read fails. */
export class Files implements FileService {
  readonly #ctx: AppContext;

  constructor(ctx: AppContext) {
    this.#ctx = ctx;
  }

  async search(): Promise<FileSearchAnswer> {
    void this.#ctx;
    throw new FileError("Searching files on your machines isn't available on this server yet.");
  }

  async read(): Promise<FileReadAnswer> {
    throw new FileError("Reading files on your machines isn't available on this server yet.");
  }

  searchResult(): void {}

  readResult(): void {}
}
