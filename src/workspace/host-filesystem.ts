import fs from "node:fs";
import path from "node:path";
import type { Workspace } from "./manager.js";
import { HostPathError, parseHostPathInput, type HostPathInput } from "./host-path-input.js";
import { DefaultHostSensitivePolicy, type HostSensitivePath, type HostSensitivePolicy } from "./host-sensitive.js";

export { HostPathError } from "./host-path-input.js";
export type { HostPathErrorCode } from "./host-path-input.js";
export type { HostSensitivePath, HostSensitivePolicy } from "./host-sensitive.js";

export type HostPath = Readonly<HostPathInput & (
  | { location: "workspace"; workspaceRelative: string }
  | { location: "external"; workspaceRelative?: never }
)>;

export type HostOperation = "read" | "write" | "delete";
export type HostOperationDecision =
  | { readonly decision: "requires-permission"; readonly operation: HostOperation; readonly target: HostPath }
  | { readonly decision: "deny"; readonly operation: "delete";
      readonly code: "EXTERNAL_DELETE_PERMANENTLY_DENIED"; readonly target: HostPath };

/**
 * Path boundary only: no I/O tools, no permission grants, and no deletion API.
 * Results are snapshots, NOT capabilities. Future I/O must revalidate immediately
 * before use and protect against symlink swaps between validation and the syscall.
 */
export class HostFilesystem {
  private readonly root: string;
  private readonly rootIdentity: fs.BigIntStats;
  private readonly defaults = new DefaultHostSensitivePolicy();

  constructor(private readonly workspace: Workspace, private readonly additionalSensitivePolicy?: HostSensitivePolicy) {
    this.root = fs.realpathSync.native(workspace.root);
    // UNC/device-backed workspaces are also outside this layer's supported scope.
    parseHostPathInput(this.root, this.root);
    this.rootIdentity = fs.statSync(this.root, { bigint: true });
  }

  private assertStableRoot(): void {
    try {
      const now = fs.statSync(this.root, { bigint: true });
      if (fs.realpathSync.native(this.root) === this.root &&
          now.isDirectory() && now.dev === this.rootIdentity.dev && now.ino === this.rootIdentity.ino) return;
    } catch { /* Missing or inaccessible root is never a safe boundary. */ }
    throw new HostPathError("WORKSPACE_ROOT_CHANGED", "Workspace root identity changed or cannot be verified");
  }

  /** Only ENOENT at lstat permits walking upwards; dangling links and all other errors fail closed. */
  private canonicalize(abs: string): string {
    let current = abs;
    const suffix: string[] = [];
    for (;;) {
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(current);
      } catch (error) {
        const parent = path.dirname(current);
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === current) {
          throw new HostPathError("CANONICALIZATION_FAILED", "Cannot verify the existing path ancestor");
        }
        suffix.unshift(path.basename(current));
        current = parent;
        continue;
      }
      try {
        const real = fs.realpathSync.native(current);
        if (suffix.length && !(stat.isDirectory() || fs.statSync(real).isDirectory())) {
          throw new Error("Existing ancestor is not a directory");
        }
        // Reparse points (including junctions) must resolve through native realpath.
        // Unresolvable/unsupported points never fall back to their lexical path.
        parseHostPathInput(real, this.root);
        return suffix.length ? path.join(real, ...suffix) : real;
      } catch {
        throw new HostPathError("CANONICALIZATION_FAILED", "Cannot canonicalize the existing path ancestor");
      }
    }
  }

  /** Single formal classifier. Native realpath restores existing component casing on Windows.
   * Exact canonical ancestors also avoid merging distinct case-sensitive Windows directories.
   */
  private classify(abs: string, inputKind: HostPathInput["inputKind"], lexical = false): HostPath {
    let current = abs;
    for (;;) {
      let isRoot = current === this.root;
      // Lexical aliases retain their entry names for policy checks, but Windows
      // root spelling may differ in case. Verify that spelling against native
      // realpath before treating it as the root; case folding alone is unsafe.
      if (!isRoot && lexical && process.platform === "win32" && path.relative(this.root, current) === "") {
        try {
          isRoot = fs.realpathSync.native(current) === this.root;
        } catch {
          throw new HostPathError("CANONICALIZATION_FAILED", "Cannot verify the lexical workspace root alias");
        }
      }
      if (isRoot) {
        return Object.freeze({ abs, inputKind, location: "workspace",
          workspaceRelative: path.relative(this.root, abs).split(path.sep).join("/") });
      }
      const parent = path.dirname(current);
      if (parent === current) return Object.freeze({ abs, inputKind, location: "external" });
      current = parent;
    }
  }

  private sensitiveContext(target: HostPath): HostSensitivePath {
    return Object.freeze({ ...target,
      rootRelative: path.relative(path.parse(target.abs).root, target.abs).split(path.sep).join("/") });
  }

  private assertNotSensitive(target: HostPath): void {
    const context = this.sensitiveContext(target);
    const relative = target.workspaceRelative;
    if (this.defaults.isSensitive(context) ||
        (relative && (this.workspace.ignoreRules.isSensitive(relative) ||
                      this.workspace.ignoreRules.isSensitive(`${relative}/`))) ||
        this.additionalSensitivePolicy?.isSensitive(context)) {
      throw new HostPathError("ACCESS_DENIED_SENSITIVE_FILE", "Path matches the sensitive-file policy");
    }
  }

  private resolveBoundary(requested: string): { target: HostPath; lexical: HostPath } {
    this.assertStableRoot();
    const input = parseHostPathInput(requested, this.root);
    const lexical = this.classify(input.abs, input.inputKind, true);
    const target = this.classify(this.canonicalize(input.abs), input.inputKind);
    if (input.inputKind === "workspace-relative" &&
        (lexical.location !== "workspace" || target.location !== "workspace")) {
      throw new HostPathError("PATH_OUTSIDE_WORKSPACE", "Workspace-relative paths must stay inside the workspace; use an explicit host absolute path");
    }
    return { target, lexical };
  }

  /** Canonical classification with mandatory sensitive guards on BOTH alias and target. */
  resolve(requested: string): HostPath {
    const { target, lexical } = this.resolveBoundary(requested);
    this.assertNotSensitive(lexical);
    this.assertNotSensitive(target);
    return target;
  }

  /** Structural decision only. Permission enforcement is a separate mandatory integration step. */
  checkOperation(requested: string, operation: HostOperation): HostOperationDecision {
    if (!["read", "write", "delete"].includes(operation)) {
      throw new HostPathError("INVALID_OPERATION", "Unknown filesystem operation");
    }
    const { target, lexical } = this.resolveBoundary(requested);
    // Deny even an external link pointing into the workspace: deleting it removes an external entry.
    if (operation === "delete" && (target.location === "external" || lexical.location === "external")) {
      return Object.freeze({ decision: "deny", operation, code: "EXTERNAL_DELETE_PERMANENTLY_DENIED", target });
    }
    this.assertNotSensitive(lexical);
    this.assertNotSensitive(target);
    return Object.freeze({ decision: "requires-permission", operation, target });
  }
}
