import { XMLParser } from "fast-xml-parser";
import type { Domain, Observation, Significance, SourceId } from "../core/types.js";
import { deriveId } from "../util/hash.js";
import { plainText, truncate } from "../util/text.js";
import { toIso } from "../util/time.js";
import type { ExtractContext, FetchRequest, SourceAdapter } from "./source.js";

export interface RssConfig {
  source: Extract<SourceId, "ftc" | "doj">;
  publisher: string;
  feeds: string[];
  userAgent: string;
  defaultDomain: Domain;
}

export interface FeedItem {
  title: string;
  link: string;
  guid: string;
  publishedAt: string | null;
  description: string;
  /** Element path of the item inside the feed document. */
  locator: string;
}

interface ActionRule {
  rule: string;
  pattern: RegExp;
  state: string;
  domain: Domain | null;
  significance: Significance;
}

/** First match wins. Recorded as the rule of the derived newState claim. */
export const RELEASE_RULES: readonly ActionRule[] = [
  { rule: "release.block", pattern: /\b(sues? to block|seeks to block|challenges?|blocks?)\b.*\b(merger|acquisition|deal|transaction)\b/i, state: "Federal challenge to a transaction announced.", domain: "m-and-a", significance: "major" },
  { rule: "release.abandoned", pattern: /\babandon(s|ed)?\b/i, state: "Transaction abandoned following regulatory scrutiny.", domain: "m-and-a", significance: "major" },
  { rule: "release.consent", pattern: /\b(consent (order|decree|agreement)|divest(iture|s)?|clears?\b.*\bwith)/i, state: "Settlement or remedy announced.", domain: null, significance: "notable" },
  { rule: "release.indictment", pattern: /\b(indict(ed|ment)|charged?|pleads? guilty|sentenced|convicted)\b/i, state: "Criminal enforcement development announced.", domain: "enforcement", significance: "major" },
  { rule: "release.complaint", pattern: /\b(sues?|lawsuit|complaint|files? suit|takes action)\b/i, state: "Enforcement action filed.", domain: "enforcement", significance: "notable" },
  { rule: "release.settlement", pattern: /\b(settle(s|ment|d)?|agree(s|ment)? to pay|penalt(y|ies))\b/i, state: "Settlement announced.", domain: "enforcement", significance: "notable" },
  { rule: "release.merger", pattern: /\b(merger|acquisition|acquire|deal)\b/i, state: "Transaction-related development announced.", domain: "m-and-a", significance: "notable" },
  { rule: "release.rule", pattern: /\b(final rule|proposed rule|rulemaking|guidelines|policy statement)\b/i, state: "Rule or policy development announced.", domain: null, significance: "notable" }
];

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  cdataPropName: false,
  trimValues: true,
  parseTagValue: false,
  processEntities: true,
  htmlEntities: true
});

const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function textOf(node: unknown): string {
  if (node === undefined || node === null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (typeof node === "object" && "#text" in node) return String((node as Record<string, unknown>)["#text"] ?? "");
  return "";
}

/** Parse RSS 2.0 or Atom 1.0 into normalized items. */
export function parseFeed(xml: string): FeedItem[] {
  // Feeds never need DTD entities; refusing them closes the entity-expansion class of attacks.
  if (/<!ENTITY/i.test(xml)) throw new Error("feed declares DTD entities; refusing to parse");
  const doc = parser.parse(xml) as Record<string, any>;

  if (doc.rss?.channel !== undefined) {
    return asArray(doc.rss.channel.item).map((item: Record<string, unknown>, i: number) => {
      const link = textOf(item.link).trim();
      return {
        title: plainText(textOf(item.title)),
        link,
        guid: textOf(item.guid).trim() || link,
        publishedAt: toIso(textOf(item.pubDate) || textOf(item["dc:date"])),
        description: plainText(textOf(item.description)),
        locator: `/rss/channel/item/${i}`
      };
    });
  }
  if (doc.feed !== undefined) {
    return asArray(doc.feed.entry).map((entry: Record<string, any>, i: number) => {
      const links = asArray(entry.link) as Record<string, string>[];
      const alt = links.find((l) => (l["@_rel"] ?? "alternate") === "alternate") ?? links[0];
      const link = (alt?.["@_href"] ?? "").trim();
      return {
        title: plainText(textOf(entry.title)),
        link,
        guid: textOf(entry.id).trim() || link,
        publishedAt: toIso(textOf(entry.published) || textOf(entry.updated)),
        description: plainText(textOf(entry.summary) || textOf(entry.content)),
        locator: `/feed/entry/${i}`
      };
    });
  }
  throw new Error("unrecognized feed format (expected RSS 2.0 or Atom)");
}

export class RssAdapter implements SourceAdapter {
  readonly minIntervalMs = 500;

  constructor(private readonly config: RssConfig) {}

  get id(): SourceId {
    return this.config.source;
  }

  plan(): FetchRequest[] {
    return this.config.feeds.map((url, i) => ({
      url,
      headers: { "user-agent": this.config.userAgent, accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5" },
      label: `${this.config.source}:feed:${i}`
    }));
  }

  extract(ctx: ExtractContext): Observation[] {
    return parseFeed(ctx.text).flatMap((item) => {
      const obs = this.itemToObservation(item, ctx);
      return obs === null ? [] : [obs];
    });
  }

  private itemToObservation(item: FeedItem, ctx: ExtractContext): Observation | null {
    let link: URL;
    try {
      link = new URL(item.link, ctx.request.url);
    } catch {
      return null;
    }
    if (link.protocol !== "https:" || item.title === "") return null;

    const rule = RELEASE_RULES.find((r) => r.pattern.test(item.title)) ?? null;
    const { source, publisher } = this.config;
    return {
      source,
      domain: rule?.domain ?? this.config.defaultDomain,
      kind: "occurrence",
      stateKey: `${source}:release:${deriveId(item.guid || link.toString()).slice(0, 20)}`,
      title: truncate(item.title, 240),
      summary: truncate(item.description, 600),
      actors: [publisher],
      instrument: null,
      action: truncate(item.title, 300),
      state: rule?.state ?? "Agency announcement published.",
      stateBasis: "derived",
      stateRule: rule?.rule ?? "release.unclassified",
      stateFacts: { title: item.title, link: link.toString() },
      statePublishedAt: item.publishedAt,
      proceduralStage: null,
      nextExpectedStage: null,
      nextStageRule: null,
      significance: rule?.significance ?? "routine",
      evidence: {
        documentId: ctx.documentId,
        locator: item.locator,
        url: link.toString(),
        title: truncate(item.title, 240),
        publisher,
        excerpt: truncate([item.title, item.description].filter(Boolean).join(" — "), 800),
        publishedAt: item.publishedAt
      }
    };
  }
}
