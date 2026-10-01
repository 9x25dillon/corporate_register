import type { Observation, Significance } from "../core/types.js";
import { plainText, truncate } from "../util/text.js";
import { toIso } from "../util/time.js";
import type { ExtractContext, FetchRequest, SourceAdapter } from "./source.js";

export interface CongressConfig {
  apiKey: string;
  limit: number;
  /** Case-insensitive substrings matched against bill titles; empty = accept all. */
  keywords: string[];
  baseUrl?: string;
}

interface BillType {
  display: string;
  spoken: string;
  slug: string;
}

const BILL_TYPES: Record<string, BillType> = {
  hr: { display: "H.R.", spoken: "House bill", slug: "house-bill" },
  s: { display: "S.", spoken: "Senate bill", slug: "senate-bill" },
  hres: { display: "H.Res.", spoken: "House resolution", slug: "house-resolution" },
  sres: { display: "S.Res.", spoken: "Senate resolution", slug: "senate-resolution" },
  hjres: { display: "H.J.Res.", spoken: "House joint resolution", slug: "house-joint-resolution" },
  sjres: { display: "S.J.Res.", spoken: "Senate joint resolution", slug: "senate-joint-resolution" },
  hconres: { display: "H.Con.Res.", spoken: "House concurrent resolution", slug: "house-concurrent-resolution" },
  sconres: { display: "S.Con.Res.", spoken: "Senate concurrent resolution", slug: "senate-concurrent-resolution" }
};

export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

export interface StageRule {
  rule: string;
  pattern: RegExp;
  stage: string;
  description: string;
  next: (originChamber: string | null) => string | null;
  significance: Significance;
}

const other = (chamber: string | null) => (chamber === "House" ? "Senate" : chamber === "Senate" ? "House" : "other chamber");

/**
 * Ordered stage classifier over Congress.gov latestAction text. First match wins,
 * so terminal stages precede intermediate ones. This is a heuristic (rule ids are
 * recorded on every derived/inferred claim so a listener can audit them).
 */
export const STAGE_RULES: readonly StageRule[] = [
  {
    rule: "congress.stage.enacted",
    pattern: /became (public|private) law|signed by (the )?president/i,
    stage: "enacted",
    description: "Enacted into law.",
    next: () => "Codification and any effective-date or implementing-rule milestones",
    significance: "major"
  },
  {
    rule: "congress.stage.vetoed",
    pattern: /vetoed/i,
    stage: "vetoed",
    description: "Vetoed by the President.",
    next: () => "A veto override vote, or no further action",
    significance: "major"
  },
  {
    rule: "congress.stage.presented",
    pattern: /presented to (the )?president/i,
    stage: "presented to the President",
    description: "Passed both chambers and presented to the President.",
    next: () => "Presidential signature or veto",
    significance: "major"
  },
  {
    rule: "congress.stage.resolving",
    pattern: /conference|resolving differences|agreed to (house|senate) amendment/i,
    stage: "resolving differences",
    description: "Chambers resolving differences between their versions.",
    next: () => "Final agreement on a single text, then presentment to the President",
    significance: "notable"
  },
  {
    rule: "congress.stage.passed",
    pattern: /passed\/agreed to in (house|senate)|passed (the )?(house|senate)/i,
    stage: "passed a chamber",
    description: "Passed a chamber.",
    next: (chamber) => `Consideration in the ${other(chamber)}`,
    significance: "major"
  },
  {
    rule: "congress.stage.calendar",
    pattern: /placed on (the )?(union|house|senate legislative) calendar|placed on calendar/i,
    stage: "on the calendar",
    description: "Placed on the floor calendar.",
    next: () => "Floor consideration",
    significance: "notable"
  },
  {
    rule: "congress.stage.reported",
    pattern: /\breported\b/i,
    stage: "reported by committee",
    description: "Reported by committee.",
    next: () => "Placement on the calendar or floor consideration",
    significance: "notable"
  },
  {
    rule: "congress.stage.markup",
    pattern: /mark-?up|subcommittee (consideration|hearings)|committee (consideration|hearings)|hearings held/i,
    stage: "in committee",
    description: "Under committee consideration.",
    next: () => "Committee vote to report the bill",
    significance: "routine"
  },
  {
    rule: "congress.stage.received",
    pattern: /received in the (house|senate)|message on (house|senate) action received/i,
    stage: "passed a chamber",
    description: "Passed the originating chamber and received in the other.",
    next: (chamber) => `Referral or consideration in the ${other(chamber)}`,
    significance: "notable"
  },
  {
    rule: "congress.stage.referred",
    pattern: /referred to|read twice/i,
    stage: "in committee",
    description: "Referred to committee.",
    next: () => "Committee hearing, markup, or vote to report",
    significance: "routine"
  },
  {
    rule: "congress.stage.introduced",
    pattern: /introduced/i,
    stage: "introduced",
    description: "Introduced.",
    next: () => "Referral to committee",
    significance: "routine"
  }
];

const PASSED_BOTH: StageRule = {
  rule: "congress.stage.passed-both",
  pattern: /passed\/agreed to in (house|senate)|passed (the )?(house|senate)/i,
  stage: "passed both chambers",
  description: "Passed both chambers.",
  next: () => "Resolution of any differences, then presentment to the President",
  significance: "major"
};

/**
 * Classify a latest-action string. A passage in the chamber opposite the bill's
 * origin means both chambers have now acted.
 */
export function classifyAction(text: string, originChamber: string | null = null): StageRule | null {
  const rule = STAGE_RULES.find((r) => r.pattern.test(text)) ?? null;
  if (rule?.rule === "congress.stage.passed" && originChamber !== null) {
    const chamber = /\b(house|senate)\b/i.exec(text)?.[1];
    if (chamber && chamber.toLowerCase() !== originChamber.toLowerCase()) return PASSED_BOTH;
  }
  return rule;
}

interface CongressBill {
  congress?: number;
  type?: string;
  number?: string | number;
  title?: string;
  originChamber?: string;
  updateDate?: string;
  latestAction?: { actionDate?: string; text?: string };
}

export class CongressAdapter implements SourceAdapter {
  readonly id = "congress" as const;
  readonly minIntervalMs = 250;
  private readonly baseUrl: string;

  constructor(private readonly config: CongressConfig) {
    this.baseUrl = config.baseUrl ?? "https://api.congress.gov";
  }

  plan(): FetchRequest[] {
    const url = new URL("/v3/bill", this.baseUrl);
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", String(this.config.limit));
    url.searchParams.set("sort", "updateDate desc");
    return [
      {
        url: url.toString(),
        // api.data.gov accepts the key as a header, which keeps it out of URLs and logs.
        headers: { "x-api-key": this.config.apiKey, accept: "application/json" },
        label: "congress:bills"
      }
    ];
  }

  extract(ctx: ExtractContext): Observation[] {
    const payload = JSON.parse(ctx.text) as { bills?: CongressBill[] };
    if (!Array.isArray(payload.bills)) throw new Error("congress: response has no bills[]");
    const keywords = this.config.keywords.map((k) => k.toLowerCase());
    const out: Observation[] = [];

    payload.bills.forEach((bill, index) => {
      const obs = billToObservation(bill, index, ctx);
      if (obs === null) return;
      if (keywords.length > 0 && !keywords.some((k) => obs.title.toLowerCase().includes(k))) return;
      out.push(obs);
    });
    return out;
  }
}

export function billToObservation(bill: CongressBill, index: number, ctx: ExtractContext): Observation | null {
  const typeKey = bill.type?.toLowerCase() ?? "";
  const type = BILL_TYPES[typeKey];
  const actionText = plainText(bill.latestAction?.text ?? "");
  const actionDate = toIso(bill.latestAction?.actionDate);
  const congress = bill.congress;
  const number = bill.number === undefined ? "" : String(bill.number).trim();
  const title = plainText(bill.title ?? "");
  if (!type || congress === undefined || !Number.isInteger(congress) || !/^\d+$/.test(number) || !actionText || !title) {
    return null;
  }

  const display = `${type.display} ${number}`;
  const chamber = bill.originChamber === "House" || bill.originChamber === "Senate" ? bill.originChamber : null;
  const rule = classifyAction(actionText, chamber);
  const stateDescription = rule?.description ?? "Pending; latest action not classified.";
  const nextStage = rule?.next(chamber) ?? null;

  return {
    source: "congress",
    domain: "legislation",
    kind: "stateful",
    stateKey: `congress:bill:${congress}:${typeKey}:${number}`,
    title: truncate(title, 240),
    summary: `${display} (${ordinal(congress)} Congress). Latest action: ${actionText}`,
    actors: chamber ? [`U.S. ${chamber}`] : ["U.S. Congress"],
    instrument: display,
    action: actionText,
    state: stateDescription,
    stateBasis: "derived",
    stateRule: rule?.rule ?? "congress.stage.unclassified",
    stateFacts: { actionDate: actionDate ?? "", actionText },
    statePublishedAt: actionDate,
    proceduralStage: rule?.stage ?? null,
    nextExpectedStage: nextStage,
    nextStageRule: nextStage === null ? null : `${rule?.rule}.next`,
    significance: rule?.significance ?? "routine",
    evidence: {
      documentId: ctx.documentId,
      locator: `/bills/${index}`,
      url: `https://www.congress.gov/bill/${ordinal(congress)}-congress/${type.slug}/${number}`,
      title: `${display} — ${truncate(title, 200)}`,
      publisher: "Congress.gov",
      excerpt: `${display}: ${title}. Latest action${bill.latestAction?.actionDate ? ` (${bill.latestAction.actionDate})` : ""}: ${actionText}`,
      publishedAt: actionDate
    }
  };
}

export function spokenBillType(typeKey: string): string | null {
  return BILL_TYPES[typeKey.toLowerCase()]?.spoken ?? null;
}
