export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type StableJsonResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: "invalid_json" };

class InvalidJsonValueError extends Error {
  readonly name = "InvalidJsonValueError";
}

const arrayValue = (input: readonly unknown[], active: Set<object>): readonly JsonValue[] => {
  if (Object.getPrototypeOf(input) !== Array.prototype) throw new InvalidJsonValueError();
  const length = input.length;
  const keys = Reflect.ownKeys(input);
  if (keys.length !== length + 1 || keys[length] !== "length") throw new InvalidJsonValueError();
  const lengthDescriptor = Object.getOwnPropertyDescriptor(input, "length");
  if (
    !lengthDescriptor ||
    !("value" in lengthDescriptor) ||
    lengthDescriptor.value !== length ||
    lengthDescriptor.enumerable ||
    lengthDescriptor.configurable ||
    typeof lengthDescriptor.writable !== "boolean"
  ) throw new InvalidJsonValueError();
  const result: JsonValue[] = [];
  for (let index = 0; index < length; index += 1) {
    if (keys[index] !== String(index)) throw new InvalidJsonValueError();
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new InvalidJsonValueError();
    result.push(jsonValue(descriptor.value, active));
  }
  return Object.freeze(result);
};

const objectValue = (input: object, active: Set<object>): { readonly [key: string]: JsonValue } => {
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw new InvalidJsonValueError();
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key !== "string")) throw new InvalidJsonValueError();
  const entries: [string, JsonValue][] = [];
  for (const key of Object.keys(input).sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new InvalidJsonValueError();
    entries.push([key, jsonValue(descriptor.value, active)]);
  }
  if (entries.length !== keys.length) throw new InvalidJsonValueError();
  return Object.freeze(Object.fromEntries(entries));
};

const jsonValue = (input: unknown, active: Set<object>): JsonValue => {
  if (input === null || typeof input === "string" || typeof input === "boolean") return input;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new InvalidJsonValueError();
    return input;
  }
  if (typeof input !== "object") throw new InvalidJsonValueError();
  if (active.has(input)) throw new InvalidJsonValueError();
  active.add(input);
  try {
    return Array.isArray(input) ? arrayValue(input, active) : objectValue(input, active);
  } finally {
    active.delete(input);
  }
};

export const toStableJsonValue = (input: unknown): StableJsonResult<JsonValue> => {
  try {
    return { ok: true, value: jsonValue(input, new Set<object>()) };
  } catch (error) {
    if (error instanceof Error) return { ok: false, code: "invalid_json" };
    return { ok: false, code: "invalid_json" };
  }
};

export const stableJsonStringify = (input: unknown): StableJsonResult<string> => {
  const converted = toStableJsonValue(input);
  if (!converted.ok) return converted;
  try {
    return { ok: true, value: JSON.stringify(converted.value) };
  } catch (error) {
    if (error instanceof Error) return { ok: false, code: "invalid_json" };
    return { ok: false, code: "invalid_json" };
  }
};
