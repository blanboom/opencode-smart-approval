export type UniqueJsonParseResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false };

const isDigit = (value: string): boolean => value >= "0" && value <= "9";
const isNonzeroDigit = (value: string): boolean => value >= "1" && value <= "9";
const isHexDigit = (value: string): boolean => (
  isDigit(value)
  || (value >= "a" && value <= "f")
  || (value >= "A" && value <= "F")
);

class JsonMemberScanner {
  private position = 0;
  private duplicate = false;

  constructor(private readonly text: string) {}

  unique(): boolean {
    this.whitespace();
    if (!this.value()) return false;
    this.whitespace();
    return this.position === this.text.length && !this.duplicate;
  }

  private value(): boolean {
    this.whitespace();
    const current = this.text.charAt(this.position);
    if (current === "{") return this.object();
    if (current === "[") return this.array();
    if (current === '"') return this.string() !== undefined;
    if (current === "t") return this.literal("true");
    if (current === "f") return this.literal("false");
    if (current === "n") return this.literal("null");
    return this.number();
  }

  private object(): boolean {
    this.position += 1;
    this.whitespace();
    if (this.consume("}")) return true;
    const members = new Set<string>();
    while (this.position < this.text.length) {
      const member = this.string();
      if (member === undefined) return false;
      if (members.has(member)) this.duplicate = true;
      members.add(member);
      this.whitespace();
      if (!this.consume(":")) return false;
      if (!this.value()) return false;
      this.whitespace();
      if (this.consume("}")) return true;
      if (!this.consume(",")) return false;
      this.whitespace();
    }
    return false;
  }

  private array(): boolean {
    this.position += 1;
    this.whitespace();
    if (this.consume("]")) return true;
    while (this.position < this.text.length) {
      if (!this.value()) return false;
      this.whitespace();
      if (this.consume("]")) return true;
      if (!this.consume(",")) return false;
    }
    return false;
  }

  private string(): string | undefined {
    if (!this.consume('"')) return undefined;
    const start = this.position - 1;
    while (this.position < this.text.length) {
      const current = this.text.charAt(this.position);
      const code = this.text.charCodeAt(this.position);
      this.position += 1;
      if (current === '"') return this.decodeString(this.text.slice(start, this.position));
      if (code < 0x20) return undefined;
      if (current !== "\\") continue;
      const escaped = this.text.charAt(this.position);
      this.position += 1;
      if ('"\\/bfnrt'.includes(escaped)) continue;
      if (escaped !== "u") return undefined;
      for (let count = 0; count < 4; count += 1) {
        if (!isHexDigit(this.text.charAt(this.position))) return undefined;
        this.position += 1;
      }
    }
    return undefined;
  }

  private decodeString(literal: string): string | undefined {
    try {
      const value: unknown = JSON.parse(literal);
      return typeof value === "string" ? value : undefined;
    } catch (error) {
      if (error instanceof SyntaxError) return undefined;
      throw error;
    }
  }

  private number(): boolean {
    const start = this.position;
    this.consume("-");
    if (this.consume("0")) {
      if (isDigit(this.text.charAt(this.position))) return false;
    } else {
      if (!isNonzeroDigit(this.text.charAt(this.position))) return false;
      while (isDigit(this.text.charAt(this.position))) this.position += 1;
    }
    if (this.consume(".")) {
      if (!isDigit(this.text.charAt(this.position))) return false;
      while (isDigit(this.text.charAt(this.position))) this.position += 1;
    }
    const exponent = this.text.charAt(this.position);
    if (exponent === "e" || exponent === "E") {
      this.position += 1;
      const sign = this.text.charAt(this.position);
      if (sign === "+" || sign === "-") this.position += 1;
      if (!isDigit(this.text.charAt(this.position))) return false;
      while (isDigit(this.text.charAt(this.position))) this.position += 1;
    }
    return this.position > start;
  }

  private literal(value: string): boolean {
    if (!this.text.startsWith(value, this.position)) return false;
    this.position += value.length;
    return true;
  }

  private consume(value: string): boolean {
    if (this.text.charAt(this.position) !== value) return false;
    this.position += 1;
    return true;
  }

  private whitespace(): void {
    while (
      this.position < this.text.length
      && " \t\r\n".includes(this.text.charAt(this.position))
    ) this.position += 1;
  }
}

export const parseUniqueJson = (text: string): UniqueJsonParseResult => {
  if (!new JsonMemberScanner(text).unique()) return { ok: false };
  try {
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch (error) {
    if (error instanceof SyntaxError) return { ok: false };
    throw error;
  }
};
