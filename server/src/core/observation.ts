import { z } from "zod";
import { CLAIM_BASES, DOMAINS, SIGNIFICANCE, SOURCES, type Observation } from "./types.js";

const nonEmpty = z.string().trim().min(1);
const isoOrNull = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO-8601 timestamp")
  .nullable();

/**
 * Adapter output is validated before it can touch the state ledger.
 * A malformed observation is an adapter bug and must never become an event.
 */
export const observationSchema = z.object({
  source: z.enum(SOURCES),
  domain: z.enum(DOMAINS),
  kind: z.enum(["stateful", "occurrence"]),
  stateKey: z.string().regex(/^[a-z]+:[\w.:-]+$/, "stateKey must be namespaced, e.g. congress:bill:119:hr:1"),
  title: nonEmpty,
  summary: z.string(),
  actors: z.array(nonEmpty),
  instrument: nonEmpty.nullable(),
  action: nonEmpty,
  state: nonEmpty,
  stateBasis: z.enum(CLAIM_BASES),
  stateRule: nonEmpty.nullable(),
  stateFacts: z.record(z.string(), z.string()).refine((r) => Object.keys(r).length > 0, "stateFacts must be non-empty"),
  statePublishedAt: isoOrNull,
  proceduralStage: nonEmpty.nullable(),
  nextExpectedStage: nonEmpty.nullable(),
  nextStageRule: nonEmpty.nullable(),
  significance: z.enum(SIGNIFICANCE),
  evidence: z.object({
    documentId: z.string().regex(/^[0-9a-f]{64}$/),
    locator: z.string().startsWith("/"),
    url: z.url({ protocol: /^https$/ }),
    title: nonEmpty,
    publisher: nonEmpty,
    excerpt: nonEmpty,
    publishedAt: isoOrNull
  })
});

export function validateObservation(input: Observation): Observation {
  const parsed = observationSchema.parse(input);
  if (parsed.stateBasis !== "source" && parsed.stateRule === null) {
    throw new Error(`observation ${parsed.stateKey}: non-source state requires stateRule`);
  }
  if (parsed.nextExpectedStage !== null && parsed.nextStageRule === null) {
    throw new Error(`observation ${parsed.stateKey}: nextExpectedStage requires nextStageRule`);
  }
  return parsed;
}
