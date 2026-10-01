import type { Env } from "../config/env.js";
import { CongressAdapter } from "./congress.js";
import { RssAdapter } from "./rss.js";
import { SecAdapter } from "./sec.js";
import type { SourceAdapter } from "./source.js";

export interface AdapterPlan {
  adapters: SourceAdapter[];
  /** Sources that are configured off, with the reason. */
  disabled: { source: string; reason: string }[];
}

export function buildAdapters(env: Env): AdapterPlan {
  const adapters: SourceAdapter[] = [];
  const disabled: AdapterPlan["disabled"] = [];

  if (env.CONGRESS_API_KEY) {
    adapters.push(new CongressAdapter({ apiKey: env.CONGRESS_API_KEY, limit: env.CONGRESS_LIMIT, keywords: env.CONGRESS_KEYWORDS }));
  } else disabled.push({ source: "congress", reason: "CONGRESS_API_KEY not set" });

  if (env.SEC_USER_AGENT && env.SEC_CIKS.length > 0) {
    adapters.push(new SecAdapter({ userAgent: env.SEC_USER_AGENT, ciks: env.SEC_CIKS, forms: env.SEC_FORMS }));
  } else disabled.push({ source: "sec", reason: "SEC_USER_AGENT and SEC_CIKS are both required" });

  if (env.FTC_FEEDS.length > 0) {
    adapters.push(
      new RssAdapter({ source: "ftc", publisher: "Federal Trade Commission", feeds: env.FTC_FEEDS, userAgent: env.HTTP_USER_AGENT, defaultDomain: "competition" })
    );
  } else disabled.push({ source: "ftc", reason: "FTC_FEEDS empty" });

  if (env.DOJ_FEEDS.length > 0) {
    adapters.push(
      new RssAdapter({
        source: "doj",
        publisher: "Department of Justice, Antitrust Division",
        feeds: env.DOJ_FEEDS,
        userAgent: env.HTTP_USER_AGENT,
        defaultDomain: "enforcement"
      })
    );
  } else disabled.push({ source: "doj", reason: "DOJ_FEEDS empty" });

  return { adapters, disabled };
}
