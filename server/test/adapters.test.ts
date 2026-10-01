import { describe, expect, it } from "vitest";
import { validateObservation } from "../src/core/observation.js";
import { classifyAction, CongressAdapter, ordinal } from "../src/ingest/congress.js";
import { parseFeed, RssAdapter } from "../src/ingest/rss.js";
import { padCik, SecAdapter } from "../src/ingest/sec.js";
import { redactUrl } from "../src/ingest/source.js";
import { ctxFor, fixture } from "./helpers.js";

describe("Congress adapter", () => {
  const adapter = new CongressAdapter({ apiKey: "secret-key", limit: 50, keywords: ["corporate", "shareholder"] });

  it("keeps the API key out of the URL", () => {
    const [req] = adapter.plan();
    expect(req!.url).not.toContain("secret-key");
    expect(req!.headers?.["x-api-key"]).toBe("secret-key");
    expect(req!.url).toContain("sort=updateDate+desc");
  });

  it("extracts keyword-relevant bills with stage, provenance locator and canonical URL", () => {
    const obs = adapter.extract(ctxFor(fixture("congress-bills.json"))).map(validateObservation);
    expect(obs.map((o) => o.stateKey)).toEqual(["congress:bill:119:hr:4821", "congress:bill:119:s:2210"]);

    const [hr, s] = obs;
    expect(hr!.instrument).toBe("H.R. 4821");
    expect(hr!.proceduralStage).toBe("in committee");
    expect(hr!.stateBasis).toBe("derived");
    expect(hr!.stateRule).toBe("congress.stage.referred");
    expect(hr!.evidence.locator).toBe("/bills/0");
    expect(hr!.evidence.url).toBe("https://www.congress.gov/bill/119th-congress/house-bill/4821");
    expect(hr!.evidence.excerpt).toContain("Referred to the House Committee on Financial Services");
    expect(hr!.statePublishedAt).toBe("2026-09-14T00:00:00.000Z");

    expect(s!.proceduralStage).toBe("passed a chamber");
    expect(s!.nextExpectedStage).toBe("Consideration in the House");
    expect(s!.significance).toBe("major");
  });

  it("classifies passage in the second chamber as passage by both", () => {
    expect(classifyAction("Passed/agreed to in House: On passage Passed by recorded vote.", "Senate")?.stage).toBe("passed both chambers");
    expect(classifyAction("Passed/agreed to in House: On passage.", "House")?.stage).toBe("passed a chamber");
    expect(classifyAction("Became Public Law No: 119-12.")?.stage).toBe("enacted");
    expect(classifyAction("Reported (Amended) by the Committee on Financial Services.")?.stage).toBe("reported by committee");
  });

  it("formats ordinals", () => {
    expect([1, 2, 3, 11, 12, 13, 21, 111, 119, 122].map(ordinal)).toEqual(["1st", "2nd", "3rd", "11th", "12th", "13th", "21st", "111th", "119th", "122nd"]);
  });
});

describe("SEC adapter", () => {
  const adapter = new SecAdapter({ userAgent: "Docket test@example.com", ciks: ["320193"], forms: ["8-K", "10-Q"] });

  it("plans one request per CIK with the declared user agent", () => {
    const [req] = adapter.plan();
    expect(req!.url).toBe("https://data.sec.gov/submissions/CIK0000320193.json");
    expect(req!.headers?.["user-agent"]).toBe("Docket test@example.com");
  });

  it("selects the latest filing per tracked form and ignores untracked forms", () => {
    const obs = adapter.extract(ctxFor(fixture("sec-submissions.json"))).map(validateObservation);
    expect(obs.map((o) => o.stateKey)).toEqual(["sec:0000320193:form:10-q", "sec:0000320193:form:8-k"]);
    const eightK = obs[1]!;
    expect(eightK.stateFacts).toEqual({ form: "8-K", accession: "0000320193-26-000101" });
    expect(eightK.state).toContain("entry into a material definitive agreement");
    expect(eightK.significance).toBe("major");
    expect(eightK.evidence.locator).toBe("/filings/recent/accessionNumber/0");
    expect(eightK.evidence.url).toBe("https://www.sec.gov/Archives/edgar/data/320193/000032019326000101/exdv-20260929.htm");
  });

  it("validates CIKs", () => {
    expect(padCik("320193")).toBe("0000320193");
    expect(() => padCik("12345678901")).toThrow();
  });
});

describe("RSS / Atom adapter", () => {
  it("parses RSS 2.0 and decodes markup in descriptions", () => {
    const items = parseFeed(fixture("ftc-competition.xml"));
    expect(items).toHaveLength(2);
    expect(items[0]!.description).toBe("The Federal Trade Commission filed an administrative complaint & will seek a preliminary injunction in federal court.");
    expect(items[0]!.locator).toBe("/rss/channel/item/0");
    expect(items[0]!.publishedAt).toBe("2026-09-29T14:30:00.000Z");
  });

  it("parses Atom", () => {
    const [entry] = parseFeed(fixture("doj-atom.xml"));
    expect(entry!.link).toBe("https://www.justice.gov/opa/pr/two-executives-indicted-bid-rigging");
    expect(entry!.locator).toBe("/feed/entry/0");
  });

  it("refuses DTD entity declarations", () => {
    const bomb = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "aaaa">]><rss><channel><item><title>&a;</title></item></channel></rss>`;
    expect(() => parseFeed(bomb)).toThrow(/DTD/);
  });

  it("emits occurrences with derived state and rule ids", () => {
    const ftc = new RssAdapter({ source: "ftc", publisher: "Federal Trade Commission", feeds: ["https://www.ftc.gov/feed.xml"], userAgent: "t", defaultDomain: "competition" });
    const obs = ftc.extract(ctxFor(fixture("ftc-competition.xml"))).map(validateObservation);
    expect(obs[0]!.kind).toBe("occurrence");
    expect(obs[0]!.domain).toBe("m-and-a");
    expect(obs[0]!.stateRule).toBe("release.block");
    expect(obs[0]!.significance).toBe("major");
    expect(obs[1]!.stateRule).toBe("release.unclassified");
  });
});

describe("redactUrl", () => {
  it("removes credentials from persisted URLs", () => {
    expect(redactUrl("https://u:p@api.example.com/x?api_key=abc&format=json&token=t")).toBe(
      "https://api.example.com/x?api_key=REDACTED&format=json&token=REDACTED"
    );
  });
});
