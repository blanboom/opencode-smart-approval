const CATEGORY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

export const isValidCategoryId = (value: string): boolean => CATEGORY_ID_PATTERN.test(value);
