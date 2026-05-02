import { z } from "zod";

export const SearchInputSchema = z.object({
  query: z.string().min(1, "must be at least 1 character").max(500, "must be 500 characters or fewer"),
  version: z
    .string()
    .regex(/^v\d+(\.\d+){0,2}$/, "must look like 'v4', 'v3.0', or 'v3.0.1'")
    .optional(),
  limit: z.number().int().min(1).max(25).optional().default(10),
});
export type SearchInput = z.infer<typeof SearchInputSchema>;

export const FetchInputSchema = z.object({
  path: z
    .string()
    .min(1, "must be at least 1 character")
    .max(500, "must be 500 characters or fewer"),
});
export type FetchInput = z.infer<typeof FetchInputSchema>;

export const BundleInputSchema = z.object({
  bundle: z
    .string()
    .min(1, "must be at least 1 character")
    .max(100, "must be 100 characters or fewer")
    .regex(/^[a-z0-9][a-z0-9-]*$/, "must be lowercase kebab-case"),
});
export type BundleInput = z.infer<typeof BundleInputSchema>;

export function fieldErrorFromZod(err: z.ZodError): { field: string; reason: string } {
  const issue = err.issues[0];
  return {
    field: issue.path.join(".") || "(root)",
    reason: issue.message,
  };
}
