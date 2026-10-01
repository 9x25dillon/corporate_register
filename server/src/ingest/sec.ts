import type { Domain, Observation, Significance } from "../core/types.js";
import { plainText } from "../util/text.js";
import { toIso } from "../util/time.js";
import type { ExtractContext, FetchRequest, SourceAdapter } from "./source.js";

export interface SecConfig {
  userAgent: string;
  ciks: string[];
  forms: string[];
  baseUrl?: string;
}

/** Form 8-K item codes (17 CFR 249.308). */
export const FORM_8K_ITEMS: Record<string, string> = {
  "1.01": "entry into a material definitive agreement",
  "1.02": "termination of a material definitive agreement",
  "1.03": "bankruptcy or receivership",
  "1.04": "mine safety",
  "1.05": "a material cybersecurity incident",
  "2.01": "completion of an acquisition or disposition of assets",
  "2.02": "results of operations and financial condition",
  "2.03": "creation of a direct financial obligation",
  "2.04": "triggering events that accelerate a financial obligation",
  "2.05": "costs of exit or disposal activities",
  "2.06": "material impairments",
  "3.01": "notice of delisting or failure to meet a listing standard",
  "3.02": "unregistered sales of equity securities",
  "3.03": "material modification to rights of security holders",
  "4.01": "a change in the certifying accountant",
  "4.02": "non-reliance on previously issued financial statements",
  "5.01": "a change in control",
  "5.02": "departure or appointment of directors or officers",
  "5.03": "amendments to the articles of incorporation or bylaws",
  "5.07": "results of a shareholder vote",
  "7.01": "a Regulation FD disclosure",
  "8.01": "other events",
  "9.01": "financial statements and exhibits"
};

const MAJOR_8K_ITEMS = new Set(["1.01", "1.02", "1.03", "1.05", "2.01", "3.01", "4.02", "5.01"]);
const NOTABLE_8K_ITEMS = new Set(["2.04", "2.06", "3.03", "4.01", "5.02", "5.03", "5.07"]);

const M_AND_A_FORMS = new Set(["S-4", "425", "DEFM14A", "PREM14A", "SC TO-T", "SC 14D9", "SC 13D", "SCHEDULE 13D", "SC 13E3"]);
const MAJOR_FORMS = new Set(["S-4", "DEFM14A", "SC TO-T", "SC 14D9", "SC 13E3"]);

export function padCik(cik: string): string {
  const digits = cik.replace(/\D/g, "");
  if (digits.length === 0 || digits.length > 10) throw new Error(`invalid CIK: ${cik}`);
  return digits.padStart(10, "0");
}

interface RecentFilings {
  accessionNumber?: string[];
  filingDate?: string[];
  reportDate?: string[];
  acceptanceDateTime?: string[];
  form?: string[];
  items?: string[];
  primaryDocument?: string[];
  primaryDocDescription?: string[];
}

interface Submissions {
  cik?: string | number;
  name?: string;
  tickers?: string[];
  filings?: { recent?: RecentFilings };
}

export class SecAdapter implements SourceAdapter {
  readonly id = "sec" as const;
  /** SEC fair access: ≤10 requests/second. */
  readonly minIntervalMs = 125;
  private readonly baseUrl: string;
  private readonly forms: Set<string>;

  constructor(private readonly config: SecConfig) {
    this.baseUrl = config.baseUrl ?? "https://data.sec.gov";
    this.forms = new Set(config.forms.map((f) => f.toUpperCase()));
  }

  plan(): FetchRequest[] {
    return this.config.ciks.map((cik) => {
      const padded = padCik(cik);
      return {
        url: new URL(`/submissions/CIK${padded}.json`, this.baseUrl).toString(),
        headers: { "user-agent": this.config.userAgent, accept: "application/json" },
        label: `sec:${padded}`
      };
    });
  }

  extract(ctx: ExtractContext): Observation[] {
    const data = JSON.parse(ctx.text) as Submissions;
    const recent = data.filings?.recent;
    if (data.cik === undefined || recent === undefined) throw new Error("sec: submissions document lacks cik or filings.recent");
    const cik = padCik(String(data.cik));
    const issuer = plainText(data.name ?? "") || `CIK ${cik}`;
    const n = recent.accessionNumber?.length ?? 0;

    // Latest filing per tracked form. Do not assume array order; compare timestamps.
    const latest = new Map<string, { index: number; at: number }>();
    for (let i = 0; i < n; i++) {
      const form = (recent.form?.[i] ?? "").toUpperCase();
      if (!this.forms.has(form)) continue;
      const at = Date.parse(recent.acceptanceDateTime?.[i] || recent.filingDate?.[i] || "");
      if (Number.isNaN(at)) continue;
      const best = latest.get(form);
      if (best === undefined || at > best.at) latest.set(form, { index: i, at });
    }

    return [...latest.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([form, { index }]) => filingToObservation(cik, issuer, form, index, recent, ctx));
  }
}

function filingToObservation(
  cik: string,
  issuer: string,
  form: string,
  i: number,
  recent: RecentFilings,
  ctx: ExtractContext
): Observation {
  const accession = recent.accessionNumber?.[i] ?? "";
  const filingDate = recent.filingDate?.[i] ?? "";
  const acceptedAt = toIso(recent.acceptanceDateTime?.[i]) ?? toIso(filingDate);
  const primaryDocument = recent.primaryDocument?.[i] ?? "";
  const description = plainText(recent.primaryDocDescription?.[i] ?? "");
  const itemCodes = (recent.items?.[i] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const itemText = itemCodes.map((c) => FORM_8K_ITEMS[c] ?? `item ${c}`);

  const reporting = itemText.length > 0 ? `, reporting ${joinList(itemText)}` : "";
  const domain: Domain = isMAndA(form, itemCodes) ? "m-and-a" : "securities";
  const cikNumber = String(Number(cik));
  const accessionPath = accession.replace(/-/g, "");
  const url = primaryDocument
    ? `https://www.sec.gov/Archives/edgar/data/${cikNumber}/${accessionPath}/${encodeURIComponent(primaryDocument)}`
    : `https://www.sec.gov/Archives/edgar/data/${cikNumber}/${accessionPath}/${accession}-index.htm`;

  return {
    source: "sec",
    domain,
    kind: "stateful",
    stateKey: `sec:${cik}:form:${form.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    title: `${issuer}, Form ${form}`,
    summary: `${issuer} filed Form ${form} on ${filingDate}${reporting}.`,
    actors: [issuer, "U.S. Securities and Exchange Commission"],
    instrument: `Form ${form}`,
    action: `Filed Form ${form}${reporting}.`,
    state: `Latest Form ${form} filed ${filingDate}${reporting}.`,
    stateBasis: "source",
    stateRule: null,
    stateFacts: { form, accession },
    statePublishedAt: acceptedAt,
    proceduralStage: null,
    nextExpectedStage: null,
    nextStageRule: null,
    significance: significanceOf(form, itemCodes),
    evidence: {
      documentId: ctx.documentId,
      locator: `/filings/recent/accessionNumber/${i}`,
      url,
      title: `${issuer} — Form ${form}${description ? ` (${description})` : ""}`,
      publisher: "SEC EDGAR",
      excerpt: [
        `Form ${form}`,
        `filed ${filingDate}`,
        `accession ${accession}`,
        itemCodes.length > 0 ? `items ${itemCodes.join(", ")}` : null,
        primaryDocument ? `primary document ${primaryDocument}` : null
      ]
        .filter((s): s is string => s !== null)
        .join("; "),
      publishedAt: acceptedAt
    }
  };
}

function isMAndA(form: string, items: string[]): boolean {
  return M_AND_A_FORMS.has(form) || (form === "8-K" && (items.includes("2.01") || items.includes("5.01")));
}

function significanceOf(form: string, items: string[]): Significance {
  if (MAJOR_FORMS.has(form) || items.some((i) => MAJOR_8K_ITEMS.has(i))) return "major";
  if (M_AND_A_FORMS.has(form) || items.some((i) => NOTABLE_8K_ITEMS.has(i))) return "notable";
  return "routine";
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join("; ")}; and ${items[items.length - 1]}`;
}
