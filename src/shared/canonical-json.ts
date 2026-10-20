import { createHash } from "node:crypto";

export class CanonicalJsonLimitError extends RangeError {
  constructor() {
    super("Canonical JSON exceeds its configured byte limit");
    this.name = "CanonicalJsonLimitError";
  }
}

export interface CanonicalJsonOptions {
  maxBytes?: number;
}

const MAX_CANONICAL_DEPTH = 256;

/**
 * Serialize a JSON value with recursively sorted object keys and preserved array
 * order. Numbers follow JSON/IEEE-754 semantics; in particular -0 serializes as
 * 0. Only plain JSON data is accepted, so hashing never depends on toJSON(),
 * getters, prototypes, or insertion order.
 */
export function canonicalJson(value: unknown, options: CanonicalJsonOptions = {}): string {
  const maxBytes = options.maxBytes;
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)) {
    throw new RangeError("Canonical JSON maxBytes must be a positive safe integer");
  }
  let encodedBytes = 0;
  const active = new WeakSet<object>();

  const charge = (text: string): string => {
    encodedBytes += Buffer.byteLength(text, "utf8");
    if (maxBytes !== undefined && encodedBytes > maxBytes) throw new CanonicalJsonLimitError();
    return text;
  };

  const visit = (item: unknown, depth = 0): string => {
    if (depth > MAX_CANONICAL_DEPTH) throw new TypeError("Canonical JSON nesting depth exceeds the supported limit");
    if (item === null) return charge("null");
    if (typeof item === "string") {
      if (maxBytes !== undefined && Buffer.byteLength(item, "utf8") > maxBytes) throw new CanonicalJsonLimitError();
      return charge(JSON.stringify(item));
    }
    if (typeof item === "boolean") return charge(item ? "true" : "false");
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new TypeError("Canonical JSON does not support non-finite numbers");
      return charge(JSON.stringify(item));
    }
    if (typeof item !== "object") {
      throw new TypeError(`Canonical JSON does not support ${typeof item}`);
    }

    if (active.has(item)) throw new TypeError("Canonical JSON does not support cyclic values");
    active.add(item);
    try {
      if (Array.isArray(item)) {
        if (Object.getPrototypeOf(item) !== Array.prototype || Object.getOwnPropertySymbols(item).length > 0) {
          throw new TypeError("Canonical JSON only supports plain arrays");
        }
        const ownNames = Object.getOwnPropertyNames(item);
        for (const name of ownNames) {
          if (name === "length") continue;
          const index = Number(name);
          if (!Number.isSafeInteger(index) || index < 0 || String(index) !== name || index >= item.length) {
            throw new TypeError("Canonical JSON does not support arrays with extra properties");
          }
        }
        const values: string[] = [charge("[")];
        for (let index = 0; index < item.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
            throw new TypeError("Canonical JSON does not support sparse arrays or accessors");
          }
          if (index > 0) values.push(charge(","));
          values.push(visit(descriptor.value, depth + 1));
        }
        values.push(charge("]"));
        return values.join("");
      }

      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError("Canonical JSON only supports plain objects");
      }
      if (Object.getOwnPropertySymbols(item).length > 0) {
        throw new TypeError("Canonical JSON does not support symbol keys");
      }
      const names = Object.getOwnPropertyNames(item);
      if (maxBytes !== undefined && names.length > Math.floor(maxBytes / 3)) throw new CanonicalJsonLimitError();
      const fields: Array<[string, unknown]> = [];
      for (const name of names) {
        const descriptor = Object.getOwnPropertyDescriptor(item, name);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw new TypeError("Canonical JSON does not support non-enumerable properties or accessors");
        }
        fields.push([name, descriptor.value]);
      }
      fields.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
      const values: string[] = [charge("{")];
      for (let index = 0; index < fields.length; index++) {
        if (index > 0) values.push(charge(","));
        const [name, fieldValue] = fields[index]!;
        if (maxBytes !== undefined && Buffer.byteLength(name, "utf8") > maxBytes) throw new CanonicalJsonLimitError();
        values.push(charge(JSON.stringify(name)));
        values.push(charge(":"));
        values.push(visit(fieldValue, depth + 1));
      }
      values.push(charge("}"));
      return values.join("");
    } finally {
      active.delete(item);
    }
  };

  return visit(value);
}

/** SHA-256 hex digest of UTF-8 canonical JSON. */
export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
