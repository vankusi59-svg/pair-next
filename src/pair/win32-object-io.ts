/**
 * P0-A — Windows-native opened-object I/O boundary for the PAIR artifact
 * security contract. This is the literal port of the Linux
 * `/proc/self/fd` design: every containment proof and every byte
 * operation is bound to ONE kernel HANDLE — the Windows equivalent of a
 * pinned fd.
 *
 * Primitives (kernel32/ntdll via koffi FFI):
 *   CreateFileW(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
 *       opens the FINAL path component as an object — a reparse point is
 *       opened AS the link object (never silently followed), matching
 *       O_NOFOLLOW on the opened object itself (stronger than lstat→open:
 *       the reparse check cannot race the open).
 *   GetFinalPathNameByHandleW → the OPENED object's canonical absolute
 *       path (== `realpath(/proc/self/fd/<fd>)`); reparse components in
 *       the ancestor chain are already resolved by the kernel.
 *   GetFileInformationByHandleEx(FileBasicInfo|FileStandardInfo|
 *       FileIdInfo) → attributes, size, volume serial + 128-bit FileId
 *       (== fstat dev/ino) — identity proof of the opened object.
 *   NtCreateFile(ObjectAttributes.RootDirectory) → name lookup anchored
 *       to a proven directory HANDLE (== `/proc/self/fd/<dirfd>/<name>`):
 *       a swapped pathname component can never redirect the operation.
 *   NtSetInformationFile(FileRenameInformation{RootDirectory,
 *       ReplaceIfExists=false}) → atomic create-if-absent publication
 *       (== link() semantics; STATUS_OBJECT_NAME_COLLISION == EEXIST).
 *   NtSetInformationFile(FileDispositionInformation{DeleteFile=true}) →
 *       handle-bound delete-on-close for temp cleanup.
 *   FlushFileBuffers(dirHandle) → real directory fsync (node fsyncSync
 *       returns EPERM on Windows dir fds — this is the durability barrier
 *       the contract requires).
 *
 * Failure posture: if the platform cannot supply any primitive (koffi
 * absent, symbol missing, handle op fails), every function fails closed —
 * callers treat null/err as "unprovable" and reject. Nothing here weakens
 * the Linux contract: this module is only invoked on win32.
 */

import path from "node:path";
import { createRequire } from "node:module";

const req = createRequire(import.meta.url);

/* eslint-disable @typescript-eslint/no-explicit-any */
type Koffi = any;

interface K32 {
  CreateFileW: (name: string, access: number, share: number, sa: null, disp: number, flags: number, tmpl: null) => unknown;
  GetFinalPathNameByHandleW: (h: unknown, buf: Buffer, len: number, flags: number) => number;
  GetFileInformationByHandleEx: (h: unknown, cls: number, buf: Buffer, len: number) => boolean;
  ReadFile: (h: unknown, buf: Buffer, n: number, read: Buffer, ov: null) => boolean;
  WriteFile: (h: unknown, buf: Buffer, n: number, written: Buffer, ov: null) => boolean;
  FlushFileBuffers: (h: unknown) => boolean;
  CloseHandle: (h: unknown) => boolean;
  GetLastError: () => number;
}
interface Nt {
  NtCreateFile: (out: Buffer, access: number, oa: Buffer, io: Buffer, alloc: null, attrs: number, share: number, disp: number, opts: number, ea: null, eaLen: number) => number;
  NtSetInformationFile: (h: unknown, io: Buffer, info: Buffer, len: number, cls: number) => number;
}

let api: { k32: K32; nt: Nt } | null | undefined;
let apiError: string | null = null;

function libs(): { k32: K32; nt: Nt } | null {
  if (api !== undefined) return api;
  try {
    const koffi = req("koffi") as Koffi;
    const k32 = koffi.load("kernel32.dll");
    const nt = koffi.load("ntdll.dll");
    api = {
      k32: {
        CreateFileW: k32.func("CreateFileW", "void*", ["str16", "uint32", "uint32", "void*", "uint32", "uint32", "void*"]),
        GetFinalPathNameByHandleW: k32.func("GetFinalPathNameByHandleW", "uint32", ["void*", "void*", "uint32", "uint32"]),
        GetFileInformationByHandleEx: k32.func("GetFileInformationByHandleEx", "bool", ["void*", "int32", "void*", "uint32"]),
        ReadFile: k32.func("ReadFile", "bool", ["void*", "void*", "uint32", "void*", "void*"]),
        WriteFile: k32.func("WriteFile", "bool", ["void*", "void*", "uint32", "void*", "void*"]),
        FlushFileBuffers: k32.func("FlushFileBuffers", "bool", ["void*"]),
        CloseHandle: k32.func("CloseHandle", "bool", ["void*"]),
        GetLastError: k32.func("GetLastError", "uint32", []),
      },
      nt: {
        NtCreateFile: nt.func("NtCreateFile", "int32", [
          "void*", "uint32", "void*", "void*", "void*",
          "uint32", "uint32", "uint32", "uint32", "void*", "uint32",
        ]),
        NtSetInformationFile: nt.func("NtSetInformationFile", "int32", ["void*", "void*", "void*", "uint32", "int32"]),
      },
    };
    return api;
  } catch (e) {
    apiError = String(e).slice(0, 200);
    api = null;
    return null;
  }
}

/** Human-visible reason the win32 object boundary is unavailable (evidence). */
export function win32ObjectIoUnavailable(): string | null {
  return api === null ? apiError ?? "koffi_unavailable" : api === undefined ? null : null;
}

/* ------------------------------------------------------------------ */
/* Access masks / flags                                                */
/* ------------------------------------------------------------------ */

export const W32 = {
  GENERIC_READ: 0x80000000,
  GENERIC_WRITE: 0x40000000,
  GENERIC_ALL: 0x10000000,
  DELETE: 0x00010000,
  SYNCHRONIZE: 0x00100000,
  FILE_READ_DATA: 0x1,
  FILE_ADD_FILE: 0x2,
  FILE_ADD_SUBDIRECTORY: 0x4,
  FILE_READ_ATTRIBUTES: 0x80,
  FILE_SHARE_ALL: 0x7,
  // CreateFileW dispositions
  OPEN_EXISTING: 3,
  // NtCreateFile dispositions
  NT_FILE_OPEN: 1,
  NT_FILE_CREATE: 2,
  NT_FILE_OPEN_IF: 3,
  // flags (CreateFileW dwFlagsAndAttributes / NtCreateFile CreateOptions)
  FLAG_BACKUP_SEMANTICS: 0x02000000,
  FLAG_OPEN_REPARSE_POINT: 0x00200000,
  OPT_DIRECTORY_FILE: 0x00000001,
  OPT_SYNCHRONOUS_IO_NONALERT: 0x00000020,
  OPT_NON_DIRECTORY_FILE: 0x00000040,
  OPT_OPEN_FOR_BACKUP_INTENT: 0x00004000,
  OPT_OPEN_REPARSE_POINT: 0x00200000,
  // attributes
  ATTR_DIRECTORY: 0x10,
  ATTR_REPARSE_POINT: 0x400,
  // NTSTATUS (as uint32)
  STATUS_OBJECT_NAME_NOT_FOUND: 0xc0000034,
  STATUS_OBJECT_PATH_NOT_FOUND: 0xc000003a,
  STATUS_OBJECT_NAME_COLLISION: 0xc0000035,
  STATUS_ACCESS_DENIED: 0xc0000022,
  STATUS_SHARING_VIOLATION: 0xc0000043,
  STATUS_NOT_A_DIRECTORY: 0xc0000103,
  STATUS_FILE_IS_A_DIRECTORY: 0xc00000ba,
  STATUS_DELETE_PENDING: 0xc0000056,
  // Win32
  ERROR_FILE_NOT_FOUND: 2,
  ERROR_PATH_NOT_FOUND: 3,
  ERROR_ACCESS_DENIED: 5,
  ERROR_INVALID_NAME: 123,
  ERROR_ALREADY_EXISTS: 183,
} as const;

/** A proved open kernel object. `handle` is a real HANDLE — never a path. */
export interface W32Object {
  readonly handle: bigint;
  /** Canonical absolute path of THIS opened object (kernel-resolved). */
  readonly finalPath: string;
  readonly isDir: boolean;
  readonly isReparse: boolean;
  readonly volumeSerial: bigint;
  readonly fileId: bigint;
  readonly fileIdHex: string;
  readonly sizeBytes: bigint;
  /** Content mutation markers (== fstat mtime/ctime stability pin). */
  readonly lastWriteTime: bigint;
  readonly changeTime: bigint;
}

export type W32OpenErr =
  | "unavailable"
  | "not_found"
  | "access_denied"
  | "name_collision"
  | "is_directory"
  | "invalid"
  | "error";

export type W32OpenResult =
  | { ok: true; obj: W32Object }
  | { ok: false; kind: W32OpenErr; status: number };

const namePool: Buffer[] = [];

function makeObjectAttributes(rootDir: bigint, name: string): Buffer {
  const nameBuf = Buffer.from(name, "utf16le");
  const us = Buffer.alloc(16);
  us.writeUInt16LE(nameBuf.length, 0);
  us.writeUInt16LE(nameBuf.length, 2);
  us.writeBigUInt64LE(BigInt(ptrOf(nameBuf)), 8);
  const oa = Buffer.alloc(48);
  oa.writeUInt32LE(48, 0);
  oa.writeBigUInt64LE(rootDir, 8);
  oa.writeBigUInt64LE(BigInt(ptrOf(us)), 16);
  oa.writeUInt32LE(0x40, 24); // OBJ_CASE_INSENSITIVE
  namePool.push(nameBuf, us);
  if (namePool.length > 64) namePool.splice(0, namePool.length - 64);
  return oa;
}

let koffiRef: Koffi;
function ptrOf(buf: Buffer): bigint | number {
  koffiRef ??= req("koffi") as Koffi;
  return BigInt(koffiRef.address(buf));
}

function iosb(): Buffer {
  return Buffer.alloc(16);
}

function invalidHandle(h: unknown): boolean {
  return h == null || BigInt(h as bigint) === 0n || BigInt(h as bigint) === 0xffffffffffffffffn;
}

function infoOf(h: bigint): Omit<W32Object, "handle" | "finalPath"> | null {
  const L = libs();
  if (!L) return null;
  const basic = Buffer.alloc(48);
  if (!L.k32.GetFileInformationByHandleEx(h, 0, basic, 48)) return null;
  const std = Buffer.alloc(24);
  if (!L.k32.GetFileInformationByHandleEx(h, 1, std, 24)) return null;
  const id = Buffer.alloc(24);
  if (!L.k32.GetFileInformationByHandleEx(h, 18, id, 24)) return null;
  const attrs = basic.readUInt32LE(32);
  return {
    isDir: std.readUInt8(21) !== 0 || (attrs & W32.ATTR_DIRECTORY) !== 0,
    isReparse: (attrs & W32.ATTR_REPARSE_POINT) !== 0,
    volumeSerial: id.readBigUInt64LE(0),
    fileId: id.readBigUInt64LE(8), // first 8 bytes of the 128-bit FileId — stable object identity
    fileIdHex: id.subarray(8, 24).toString("hex"),
    sizeBytes: std.readBigUInt64LE(8),
    lastWriteTime: basic.readBigInt64LE(16),
    changeTime: basic.readBigInt64LE(24),
  };
}

function finalPathOf(h: bigint): string | null {
  const L = libs();
  if (!L) return null;
  const buf = Buffer.alloc(8192);
  const n = L.k32.GetFinalPathNameByHandleW(h, buf, 4096, 0);
  if (!n || n >= 4096) return null;
  let s = buf.toString("utf16le", 0, n * 2);
  if (s.startsWith("\\\\?\\UNC\\")) s = "\\\\" + s.slice(8);
  else if (s.startsWith("\\\\?\\")) s = s.slice(4);
  return s;
}

function wrapObject(h: bigint): W32Object | null {
  const fp = finalPathOf(h);
  const inf = infoOf(h);
  if (fp == null || inf == null) return null;
  return { handle: h, finalPath: fp, ...inf };
}

function classifyNtErr(status: number): W32OpenErr {
  const s = status >>> 0;
  switch (s) {
    case W32.STATUS_OBJECT_NAME_NOT_FOUND:
    case W32.STATUS_OBJECT_PATH_NOT_FOUND:
      return "not_found";
    case W32.STATUS_ACCESS_DENIED:
      return "access_denied";
    case W32.STATUS_OBJECT_NAME_COLLISION:
      return "name_collision";
    case W32.STATUS_FILE_IS_A_DIRECTORY:
    case W32.STATUS_NOT_A_DIRECTORY:
      return "is_directory";
    default:
      return "error";
  }
}

function classifyWin32Err(code: number): W32OpenErr {
  switch (code) {
    case W32.ERROR_FILE_NOT_FOUND:
    case W32.ERROR_PATH_NOT_FOUND:
      return "not_found";
    case W32.ERROR_ACCESS_DENIED:
      return "access_denied";
    case W32.ERROR_ALREADY_EXISTS:
      return "name_collision";
    case W32.ERROR_INVALID_NAME:
      return "invalid";
    default:
      return "error";
  }
}

/**
 * Open an absolute path as an object (file or directory). Equivalent of
 * `open(p, O_RDONLY|O_NOFOLLOW)` + dir support: OPEN_REPARSE_POINT makes
 * the final component's reparse point visible on the OPENED object
 * (isReparse === the Linux ELOOP branch). BACKUP_SEMANTICS allows
 * opening directories. Caller must close via {@link closeObject}.
 */
export function openObject(
  absPath: string,
  opts: {
    access?: number;
    directory?: boolean;
    /** Follow reparse points instead of opening the link object. Used only
     *  where the caller wants the real target object (e.g. directory fsync)
     *  — artifact ingest always keeps the strict link-visible mode. */
    followReparse?: boolean;
  } = {},
): W32OpenResult {
  const L = libs();
  if (!L) return { ok: false, kind: "unavailable", status: 0 };
  const access =
    opts.access ??
    (W32.GENERIC_READ | W32.GENERIC_WRITE | W32.SYNCHRONIZE);
  const options =
    (opts.directory ? W32.OPT_DIRECTORY_FILE | W32.OPT_OPEN_FOR_BACKUP_INTENT : W32.OPT_NON_DIRECTORY_FILE) |
    W32.OPT_SYNCHRONOUS_IO_NONALERT;
  let h: unknown;
  try {
    h = L.k32.CreateFileW(
      absPath,
      access,
      W32.FILE_SHARE_ALL,
      null,
      W32.OPEN_EXISTING,
      W32.FLAG_BACKUP_SEMANTICS |
        (opts.followReparse ? 0 : W32.FLAG_OPEN_REPARSE_POINT) |
        options,
      null,
    );
  } catch {
    return { ok: false, kind: "error", status: 0 };
  }
  if (invalidHandle(h)) {
    return { ok: false, kind: classifyWin32Err(L.k32.GetLastError()), status: L.k32.GetLastError() };
  }
  const obj = wrapObject(BigInt(h as bigint));
  if (!obj) {
    try { L.k32.CloseHandle(h); } catch { /* noop */ }
    return { ok: false, kind: "error", status: 0 };
  }
  return { ok: true, obj };
}

/**
 * Open (or create) `name` INSIDE the proven directory object `dirObj`.
 * This is the Windows fd-relative operation: the lookup is anchored to
 * the OPENED directory handle, not the mutable pathname — identical to
 * `/proc/self/fd/<dirfd>/<name>` on Linux. Single component only.
 */
export function openChildObject(
  dirObj: W32Object,
  name: string,
  opts: { access?: number; directory?: boolean; create?: "open" | "create" | "open_if" } = {},
): W32OpenResult {
  const L = libs();
  if (!L) return { ok: false, kind: "unavailable", status: 0 };
  if (/[\\/]/.test(name) || name === "." || name === "..") {
    return { ok: false, kind: "invalid", status: 0 };
  }
  const access =
    opts.access ??
    (W32.GENERIC_READ | W32.GENERIC_WRITE | W32.DELETE | W32.SYNCHRONIZE);
  const options =
    (opts.directory
      ? W32.OPT_DIRECTORY_FILE | W32.OPT_OPEN_FOR_BACKUP_INTENT
      : W32.OPT_NON_DIRECTORY_FILE) |
    W32.OPT_SYNCHRONOUS_IO_NONALERT |
    W32.OPT_OPEN_REPARSE_POINT;
  const disp =
    opts.create === "create"
      ? W32.NT_FILE_CREATE
      : opts.create === "open_if"
        ? W32.NT_FILE_OPEN_IF
        : W32.NT_FILE_OPEN;
  const out = Buffer.alloc(8);
  const oa = makeObjectAttributes(dirObj.handle, name);
  let status: number;
  try {
    status = L.nt.NtCreateFile(out, access, oa, iosb(), null, 0, W32.FILE_SHARE_ALL, disp, options, null, 0);
  } catch {
    return { ok: false, kind: "error", status: 0 };
  }
  if (status < 0) {
    return { ok: false, kind: classifyNtErr(status), status: status >>> 0 };
  }
  const h = BigInt(out.readBigUInt64LE(0));
  const obj = wrapObject(h);
  if (!obj) {
    try { L.k32.CloseHandle(h); } catch { /* noop */ }
    return { ok: false, kind: "error", status: 0 };
  }
  return { ok: true, obj };
}

/** Bounded read on the SAME opened object. Returns null on IO failure. */
export function readObject(obj: W32Object, maxBytes: number): Buffer | null {
  const L = libs();
  if (!L || obj.sizeBytes > BigInt(maxBytes)) return null;
  const size = Number(obj.sizeBytes);
  const buf = Buffer.alloc(size || 1);
  let off = 0;
  const rd = Buffer.alloc(4);
  while (off < size) {
    if (!L.k32.ReadFile(obj.handle, buf.subarray(off), size - off, rd, null)) return null;
    const n = rd.readUInt32LE(0);
    if (n === 0) return null; // EOF before advertised size — torn object
    off += n;
  }
  return size === 0 ? Buffer.alloc(0) : buf;
}

/** Full write on the SAME opened object (fresh objects start at offset 0). */
export function writeObject(obj: W32Object, bytes: Buffer): boolean {
  const L = libs();
  if (!L) return false;
  let off = 0;
  const wd = Buffer.alloc(4);
  while (off < bytes.length) {
    if (!L.k32.WriteFile(obj.handle, bytes.subarray(off), bytes.length - off, wd, null)) return false;
    const n = wd.readUInt32LE(0);
    if (n === 0) return false;
    off += n;
  }
  return true;
}

/** FlushFileBuffers — file AND directory durability barrier. */
export function flushObject(obj: W32Object): boolean {
  const L = libs();
  if (!L) return false;
  return L.k32.FlushFileBuffers(obj.handle) === true;
}

/**
 * Atomic no-replace publication INSIDE `dirObj` under `name` — the opened
 * object is renamed within the proven directory handle
 * (FileRenameInformation, ReplaceIfExists=false). Same guarantee as the
 * Linux link()/EEXIST publish: a concurrent name can never be
 * overwritten. Returns "exists" on STATUS_OBJECT_NAME_COLLISION.
 */
export function renameIntoDir(
  obj: W32Object,
  dirObj: W32Object,
  name: string,
): "ok" | "exists" | { kind: "error"; status: number } {
  const L = libs();
  if (!L) return { kind: "error", status: 0 };
  if (/[\\/]/.test(name) || name === "." || name === "..") {
    return { kind: "error", status: 0 };
  }
  const nameBuf = Buffer.from(name, "utf16le");
  const ri = Buffer.alloc(24 + nameBuf.length);
  ri.writeUInt8(0, 0); // ReplaceIfExists = FALSE
  ri.writeBigUInt64LE(dirObj.handle, 8); // RootDirectory
  ri.writeUInt32LE(nameBuf.length, 16);
  nameBuf.copy(ri, 20);
  let status: number;
  try {
    status = L.nt.NtSetInformationFile(obj.handle, iosb(), ri, ri.length, 10);
  } catch {
    return { kind: "error", status: 0 };
  }
  if (status >= 0) return "ok";
  const s = status >>> 0;
  if (s === W32.STATUS_OBJECT_NAME_COLLISION) return "exists";
  return { kind: "error", status: s };
}

/** Mark the opened object delete-on-close (temp cleanup). */
export function deleteOnClose(obj: W32Object): boolean {
  const L = libs();
  if (!L) return false;
  const di = Buffer.alloc(8);
  di.writeUInt8(1, 0); // DeleteFile = TRUE
  try {
    return L.nt.NtSetInformationFile(obj.handle, iosb(), di, 8, 13) >= 0;
  } catch {
    return false;
  }
}

export function closeObject(obj: W32Object | bigint | unknown): void {
  const L = libs();
  if (!L) return;
  const h = typeof obj === "object" && obj !== null && "handle" in obj
    ? (obj as W32Object).handle
    : (obj as bigint);
  try { L.k32.CloseHandle(h); } catch { /* noop */ }
}

/** Re-probe the SAME opened object — identity/stability fields only. Used
 *  for the post-read re-stat pin (== re-fstat on the same fd). */
export function objectInfo(
  obj: W32Object,
): Omit<W32Object, "handle" | "finalPath"> | null {
  return infoOf(obj.handle);
}



/**
 * Case-insensitive containment check matching NTFS semantics: `candidate`
 * is `root` itself or strictly inside it. Both sides are kernel-canonical
 * paths (no `\\?\` prefix — {@link finalPathOf} strips it).
 */
export function win32PathWithin(candidate: string, root: string): boolean {
  const r = path.resolve(root).toLowerCase();
  const c = path.resolve(candidate).toLowerCase();
  return c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}
