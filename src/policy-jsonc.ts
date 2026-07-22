export const stripJsonComments = (text: string): string => {
  let output = "";
  let index = 0;
  let inString = false;
  let escaped = false;
  while (index < text.length) {
    const char = text.charAt(index);
    const next = text.charAt(index + 1);
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      index += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      index += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      index += 2;
      while (index < text.length && text.charAt(index) !== "\n") index += 1;
      if (index < text.length) output += "\n";
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      let terminated = false;
      while (index < text.length && !(text.charAt(index) === "*" && text.charAt(index + 1) === "/")) {
        if (text.charAt(index) === "\n") output += "\n";
        index += 1;
      }
      if (index < text.length) terminated = true;
      if (!terminated) throw new SyntaxError("unterminated block comment");
      index += 2;
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
};

export const parsePolicyJsonc = (text: string): unknown => {
  return JSON.parse(stripJsonComments(text));
};
