export const TRANSFER_CHUNK_BYTES = 64 * 1024;

export enum FileKind {
  FILE = "file",
  DIRECTORY = "directory",
  SYMLINK = "symlink",
  OTHER = "other",
}

export interface FileInfo {
  readonly path: string;
  readonly name: string;
  readonly kind: FileKind;
  readonly size: number;
  readonly mode: number;
  readonly modifiedAt: Date;
}
