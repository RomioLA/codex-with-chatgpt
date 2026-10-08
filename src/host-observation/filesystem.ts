import fs from "node:fs";
import path from "node:path";
import { HostFilesystem, HostPathError, type HostSensitivePolicy } from "../workspace/host-filesystem.js";
import { parseHostPathInput } from "../workspace/host-path-input.js";
import type { Workspace } from "../workspace/manager.js";
import { ObservationError, type ObservationProvider, type FieldStatuses } from "./types.js";

/** Additional metadata guards; existing mandatory file policy is always applied too. */
export const metadataSensitivePolicy: HostSensitivePolicy = {
  isSensitive(target) {
    const normalized = target.abs.replace(/\\/g, "/").toLowerCase();
    return /(?:^|\/)(?:browser_profile|login data|web data|local state|credential[^/]*|vault|protect)(?:\/|$)/.test(normalized) ||
      /\/(?:google\/chrome|chromium|microsoft\/edge)\/user data(?:\/|$)/.test(normalized) ||
      /\/mozilla\/firefox\/profiles(?:\/|$)/.test(normalized) ||
      /\/\.config\/(?:google-chrome|chromium)(?:\/|$)/.test(normalized);
  },
};
function filesystemError(error: unknown): never {
  if (error instanceof HostPathError) {
    throw new ObservationError(error.code === "ACCESS_DENIED_SENSITIVE_FILE" ? "SENSITIVE_PATH_DENIED" : error.code, "Path metadata policy denied or could not verify this path");
  }
  const code = (error as NodeJS.ErrnoException).code;
  throw new ObservationError(code === "EACCES" || code === "EPERM" ? "ACCESS_DENIED" : "PATH_UNVERIFIABLE", "Cannot safely inspect path metadata");
}
export async function inspectPath(workspace: Workspace, requested: string, provider: ObservationProvider) {
  const host = new HostFilesystem(workspace, metadataSensitivePolicy);
  try {
    // Both absolute local-drive and workspace-relative paths use the V1 parser.
    const lexical = parseHostPathInput(requested, workspace.root).abs;
    const target = host.resolve(requested);
    let entry: fs.BigIntStats;
    try { entry = fs.lstatSync(lexical, { bigint: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { inputPath: requested, absolutePath: lexical, canonicalPath: target.abs, exists: false,
        type: null, size: null, fileId: null, volumeId: null, owner: null, aclSummary: null, attributes: null,
        reparsePoint: null, reparseTag: null, reparseTarget: null, hardLinkCount: null, timestamps: null,
        fieldStatus: Object.fromEntries(["type", "size", "fileId", "volumeId", "owner", "aclSummary", "attributes",
          "reparsePoint", "reparseTarget", "hardLinkCount", "timestamps"].map(k => [k, "UNAVAILABLE"])), capturedAt: new Date().toISOString() };
    }
    const physical = fs.statSync(target.abs, { bigint: true });
    if (!physical.isFile() && !physical.isDirectory()) {
      throw new ObservationError("NOT_SUPPORTED", "Only regular file and directory metadata is supported");
    }
    const metadata = await provider.metadata(target.abs);
    const handleIdentity = metadata.handleIdentity as { fileId: string; volumeId: string } | null;
    // Bind ACL/attributes to the object observed before querying, closing ABA swaps.
    if (!handleIdentity) throw new ObservationError("ACCESS_DENIED", "Cannot bind path metadata to a verified file handle");
    if (handleIdentity.fileId !== physical.ino.toString() || handleIdentity.volumeId !== physical.dev.toString()) {
      throw new ObservationError("PATH_CHANGED", "Metadata handle does not match the authorized path identity");
    }
    // Metadata is never a capability. Recheck policy/alias/identity after async system work.
    // A detected swap suppresses ALL metadata rather than exposing the new target.
    const now = host.resolve(requested);
    const currentEntry = fs.lstatSync(lexical, { bigint: true });
    const currentPhysical = fs.statSync(now.abs, { bigint: true });
    if (now.abs !== target.abs || currentEntry.ino !== entry.ino || currentEntry.dev !== entry.dev ||
        currentPhysical.ino !== physical.ino || currentPhysical.dev !== physical.dev) {
      throw new ObservationError("PATH_CHANGED", "Path identity changed during inspection");
    }
    const linked = entry.isSymbolicLink();
    const reparsePoint = linked || (typeof metadata.attributes === "string" && metadata.attributes.includes("ReparsePoint"));
    const fieldStatus: FieldStatuses = {
      canonicalPath: "AVAILABLE", type: "AVAILABLE", size: "AVAILABLE", timestamps: "AVAILABLE",
      fileId: "AVAILABLE", volumeId: "AVAILABLE", hardLinkCount: "AVAILABLE",
      reparsePoint: "AVAILABLE", reparseTag: "NOT_SUPPORTED", reparseTarget: linked ? "AVAILABLE" : reparsePoint ? "NOT_SUPPORTED" : "UNAVAILABLE",
      ...(metadata.fieldStatus as FieldStatuses),
    };
    return { ...metadata, inputPath: requested, absolutePath: lexical, canonicalPath: target.abs, exists: true,
      type: physical.isDirectory() ? "directory" : physical.isFile() ? "file" : "other",
      size: physical.size.toString(), fileId: physical.ino.toString(), volumeId: physical.dev.toString(),
      identitySource: "Node native stat (Windows BY_HANDLE_FILE_INFORMATION)",
      hardLinkCount: Number(physical.nlink), reparsePoint, reparseTag: null,
      // Canonical target only; raw stored link payloads could disclose unchecked sensitive paths.
      reparseTarget: linked ? target.abs : null,
      entryIdentity: { fileId: entry.ino.toString(), volumeId: entry.dev.toString() },
      timestamps: { createdAt: physical.birthtime.toISOString(), modifiedAt: physical.mtime.toISOString(), accessedAt: physical.atime.toISOString() },
      fieldStatus, capturedAt: new Date().toISOString() };
  } catch (error) {
    if (error instanceof ObservationError) throw error;
    return filesystemError(error);
  }
}
