import { z } from "zod";
import { splitList } from "../util/text.js";

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v.trim()));

const list = (fallback: string) =>
  z
    .string()
    .optional()
    .transform((v) => splitList(v ?? fallback));

const optionalNumber = (min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === "") return undefined;
      const n = Number(v);
      if (!Number.isFinite(n) || n < min || n > max) {
        ctx.addIssue({ code: "custom", message: `must be a number in [${min}, ${max}]` });
        return z.NEVER;
      }
      return n;
    });

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? fallback : /^(1|true|yes|on)$/i.test(v)));

/** Default corporate/business-law relevance filter for Congress.gov bill titles. */
export const DEFAULT_CONGRESS_KEYWORDS = [
  "securities",
  "exchange act",
  "corporat",
  "merger",
  "acquisition",
  "antitrust",
  "competition",
  "shareholder",
  "investor",
  "disclosure",
  "beneficial owner",
  "fiduciary",
  "bankruptcy",
  "audit",
  "capital formation",
  "financial",
  "banking",
  "commodit",
  "consumer protection",
  "small business"
].join(",");

export const DEFAULT_SEC_FORMS = "8-K,10-K,10-Q,S-4,425,DEFM14A,SC TO-T,SC 14D9,SC 13D,SCHEDULE 13D";

/** FTC Competition press releases. DOJ feeds must be configured explicitly (see README). */
export const DEFAULT_FTC_FEEDS = "https://www.ftc.gov/feeds/press-release-competition.xml";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  /** Bearer token required on mutating routes. Mandatory in production. */
  API_TOKEN: optionalString,

  /** postgres://... — when unset the server runs on a non-durable in-memory store. */
  DATABASE_URL: optionalString,
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  HTTP_USER_AGENT: z.string().default("Docket/0.2 (legal-change monitor)"),
  HTTP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(20_000),

  CONGRESS_API_KEY: optionalString,
  CONGRESS_LIMIT: z.coerce.number().int().min(1).max(250).default(50),
  CONGRESS_KEYWORDS: list(DEFAULT_CONGRESS_KEYWORDS),

  /** SEC fair-access policy requires a descriptive UA with contact details. */
  SEC_USER_AGENT: optionalString,
  SEC_CIKS: list(""),
  SEC_FORMS: list(DEFAULT_SEC_FORMS),

  FTC_FEEDS: list(DEFAULT_FTC_FEEDS),
  DOJ_FEEDS: list(""),

  ELEVENLABS_API_KEY: optionalString,
  ELEVENLABS_VOICE_ID: optionalString,
  ELEVENLABS_MODEL_ID: z.string().default("eleven_v4"),
  ELEVENLABS_OUTPUT_FORMAT: z.string().regex(/^mp3_\d+_\d+$/, "only mp3_* formats are supported").default("mp3_44100_128"),
  ELEVENLABS_BASE_URL: z.url().default("https://api.elevenlabs.io"),
  ELEVENLABS_TIMESTAMPS: bool(true),
  ELEVENLABS_MAX_CHARS: z.coerce.number().int().min(500).max(40_000).default(3000),
  ELEVENLABS_STABILITY: optionalNumber(0, 1),
  ELEVENLABS_SIMILARITY_BOOST: optionalNumber(0, 1),
  ELEVENLABS_STYLE: optionalNumber(0, 1),
  ELEVENLABS_SPEED: optionalNumber(0.5, 2),

  AUDIO_DIR: z.string().default("./data/audio"),

  /** 0 disables the background ingestion worker. */
  INGEST_INTERVAL_MINUTES: z.coerce.number().min(0).max(24 * 60).default(0)
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid environment: ${detail}`);
  }
  const env = result.data;
  if (env.NODE_ENV === "production") {
    if (env.API_TOKEN === undefined || env.API_TOKEN.length < 24) {
      throw new Error("API_TOKEN (≥24 chars) is required in production");
    }
    if (env.DATABASE_URL === undefined) {
      throw new Error("DATABASE_URL is required in production: What Changed? needs durable state");
    }
  }
  return env;
}
