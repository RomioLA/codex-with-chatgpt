import path from "node:path";

export type HostPathErrorCode =
  | "INVALID_PATH"
  | "UNSUPPORTED_PATH_FORMAT"
  | "PATH_OUTSIDE_WORKSPACE"
  | "CANONICALIZATION_FAILED"
  | "WORKSPACE_ROOT_CHANGED"
  | "ACCESS_DENIED_SENSITIVE_FILE"
  | "INVALID_OPERATION";

export class HostPathError extends Error {
  constructor(public readonly code: HostPathErrorCode, message: string) {
    super(message);
    this.name = "HostPathError";
  }
}

export interface HostPathInput {
  readonly abs: string;
  readonly inputKind: "workspace-relative" | "host-absolute";
}

/** Pure syntax parsing only; this never classifies or authorizes a filesystem path. */
export function parseHostPathInput(
  requested: string,
  workspaceRoot: string,
  platform: NodeJS.Platform = process.platform,
): HostPathInput {
  if (typeof requested !== "string" || /[\x00-\x1f]/.test(requested) || requested !== requested.trim()) {
    throw new HostPathError("INVALID_PATH", "Invalid or ambiguous path");
  }
  const windows = platform === "win32";
  const paths = windows ? path.win32 : path.posix;
  let input = requested.replace(/\\/g, "/");
  let alias = false;
  if (/^workspace:/i.test(input)) {
    if (!/^workspace:\/(?!\/)/i.test(input)) {
      throw new HostPathError("INVALID_PATH", "Use the workspace:/ relative-path alias");
    }
    alias = true;
    input = input.slice("workspace:/".length);
  }
  if (input.startsWith("//")) {
    throw new HostPathError("UNSUPPORTED_PATH_FORMAT", "UNC and Windows device namespaces are not supported");
  }
  const driveAbsolute = /^[a-z]:\//i.test(input);
  if (/^[a-z]:/i.test(input) && !driveAbsolute) {
    throw new HostPathError("INVALID_PATH", "Drive-relative paths are ambiguous");
  }
  if (alias && (driveAbsolute || input.startsWith("/"))) {
    throw new HostPathError("INVALID_PATH", "The workspace alias requires a relative path");
  }
  if (!windows && driveAbsolute) {
    throw new HostPathError("UNSUPPORTED_PATH_FORMAT", "Windows drive paths require a Windows host");
  }
  if (windows && input.startsWith("/")) {
    throw new HostPathError("INVALID_PATH", "Windows absolute paths require an explicit drive");
  }
  const body = driveAbsolute ? input.slice(3) : input;
  if (body.includes(":")) {
    throw new HostPathError("INVALID_PATH", "Schemes and alternate data streams are not supported");
  }
  if (windows) {
    for (const part of body.split("/")) {
      if (part === "" || part === "." || part === "..") continue;
      if (/[<>"|?*]/.test(part) || /[. ]$/.test(part) ||
          /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)) {
        throw new HostPathError("INVALID_PATH", "Ambiguous or reserved Windows path component");
      }
    }
  }
  const inputKind = driveAbsolute || (!windows && paths.isAbsolute(input))
    ? "host-absolute" : "workspace-relative";
  return { abs: paths.resolve(workspaceRoot, input || "."), inputKind };
}
