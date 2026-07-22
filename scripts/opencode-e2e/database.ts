import { Database } from "bun:sqlite";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { HarnessContractError } from "./errors";

const CountSchema = z.object({ count: z.number().int().nonnegative() }).strict();

export const countSessionRows = (path: string): number => {
  if (!isAbsolute(path)) throw new HarnessContractError("environment");
  let database: Database | undefined;
  try {
    database = new Database(path, { readonly: true, strict: true });
    const parsed = CountSchema.safeParse(database.query("SELECT COUNT(*) AS count FROM session").get());
    if (!parsed.success) throw new HarnessContractError("sdk_malformed");
    return parsed.data.count;
  } catch (error) {
    if (error instanceof HarnessContractError) throw error;
    throw new HarnessContractError("sdk_malformed");
  } finally {
    database?.close();
  }
};
