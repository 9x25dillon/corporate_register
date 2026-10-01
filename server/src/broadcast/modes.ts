import type { BroadcastMode } from "../core/types.js";

export interface ModeProfile {
  title: string;
  /** Leading audio-tag direction for ElevenLabs v4. Delivery only, never facts. */
  delivery: string;
  opening: string;
  closing: string;
  structure: readonly string[];
  maxItems: number;
  /** Whether a compiler exists for this mode in this build. */
  implemented: boolean;
}

export const MODES: Record<BroadcastMode, ModeProfile> = {
  "morning-docket": {
    title: "Morning Docket",
    delivery: "[low, steady voice, restrained, evenly paced, calm and unemotional]",
    opening: "Morning Docket.",
    closing: "End of docket.",
    structure: ["event", "previous state", "new state", "why it matters", "next observable event"],
    maxItems: 12,
    implemented: false
  },
  "legislative-drift": {
    title: "Legislative Drift",
    delivery: "[measured analytical voice, unhurried, neutral, consistent rhythm]",
    opening: "Legislative Drift.",
    closing: "End of drift.",
    structure: ["instrument", "previous procedural state", "latest action", "current procedural state", "next stage"],
    maxItems: 15,
    implemented: false
  },
  "enforcement-pulse": {
    title: "Enforcement Pulse",
    delivery: "[low steady voice, precise diction, restrained emphasis]",
    opening: "Enforcement Pulse.",
    closing: "End of pulse.",
    structure: ["agency", "target", "allegation or action", "procedural posture", "current consequence"],
    maxItems: 12,
    implemented: false
  },
  "case-law": {
    title: "Case Law",
    delivery: "[dry deliberate narration, careful diction, slow transitions]",
    opening: "Case Law.",
    closing: "End of case law.",
    structure: ["court", "case", "question", "holding", "procedural effect", "precedential significance"],
    maxItems: 10,
    implemented: false
  },
  "m-and-a": {
    title: "M and A",
    delivery: "[calm clipped narration, careful with numbers and company names]",
    opening: "Mergers and acquisitions.",
    closing: "End of mergers and acquisitions.",
    structure: ["transaction", "value", "regulatory state", "latest development", "remaining condition"],
    maxItems: 10,
    implemented: false
  },
  securities: {
    title: "Securities",
    delivery: "[neutral consistent voice, measured cadence, precise numbers]",
    opening: "Securities.",
    closing: "End of securities.",
    structure: ["issuer or regulator", "filing or rule", "change", "effective consequence"],
    maxItems: 12,
    implemented: false
  },
  "what-changed": {
    title: "What Changed?",
    delivery: "[low, steady voice, minimal affect, precise diction, calm rhythmic cadence]",
    opening: "What changed.",
    closing: "End of changes.",
    structure: ["previous state", "trigger", "new state", "difference", "next observable trigger"],
    maxItems: 20,
    implemented: true
  }
};

export const PAUSE = { brief: "[brief pause]", long: "[long pause]" } as const;
