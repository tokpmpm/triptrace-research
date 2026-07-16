import { z } from "zod";

const researchLocationText = z.string()
  .trim()
  .min(2)
  .max(80)
  .regex(/^[\p{L}\p{N}\s'’&.,()\-]+$/u, "Use a place or city name, not a URL or search expression.");

export const researchPlaceRequestSchema = z.object({
  place: researchLocationText,
  city: researchLocationText,
  force: z.boolean().optional().default(false)
});

export type ResearchPlaceRequest = z.infer<typeof researchPlaceRequestSchema>;
