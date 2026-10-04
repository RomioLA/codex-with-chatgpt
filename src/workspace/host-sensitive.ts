import ignore from "ignore";
import { SENSITIVE_PATTERNS } from "./ignore.js";

/** Paths projected relative to their volume root, never raw absolute ignore inputs. */
export interface HostSensitivePath {
  readonly abs: string;
  readonly rootRelative: string;
  readonly location: "workspace" | "external";
  readonly workspaceRelative?: string;
}

export interface HostSensitivePolicy {
  isSensitive(target: HostSensitivePath): boolean;
}

/** Mandatory defaults are separate from workspace .c2cignore and cannot be disabled. */
export class DefaultHostSensitivePolicy implements HostSensitivePolicy {
  private readonly rules = ignore().add(SENSITIVE_PATTERNS);

  isSensitive(target: HostSensitivePath): boolean {
    const relative = target.rootRelative;
    if (!relative) return false;
    // Check directory markers too: .ssh itself is as sensitive as .ssh/config.
    return this.rules.ignores(relative) || this.rules.ignores(`${relative}/`);
  }
}
