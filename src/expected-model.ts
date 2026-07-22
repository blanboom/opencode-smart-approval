import { z } from "zod";

export type ExpectedModel =
  | {
      readonly source: "v3_or_small_model";
      readonly providerID: string;
      readonly modelID: string;
    }
  | { readonly source: "inherited" };

export type ExpectedModelResult =
  | { readonly ok: true; readonly value: ExpectedModel }
  | { readonly ok: false; readonly code: "invalid_model" };

const ModelIdentitySchema = z.strictObject({
  providerID: z.string().min(1),
  modelID: z.string().min(1),
});

export const expectedModelFromConfigured = (model: string | undefined): ExpectedModelResult => {
  if (model === undefined) return { ok: true, value: { source: "inherited" } };
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) return { ok: false, code: "invalid_model" };
  return {
    ok: true,
    value: {
      source: "v3_or_small_model",
      providerID: model.slice(0, separator),
      modelID: model.slice(separator + 1),
    },
  };
};

export const expectedModelMatches = (
  expected: ExpectedModel,
  actual: unknown,
  allowInheritedSelection: boolean,
): boolean => {
  if (expected.source === "inherited") {
    return allowInheritedSelection ? ModelIdentitySchema.safeParse(actual).success : actual === undefined;
  }
  const parsed = ModelIdentitySchema.safeParse(actual);
  return parsed.success &&
    parsed.data.providerID === expected.providerID &&
    parsed.data.modelID === expected.modelID;
};
