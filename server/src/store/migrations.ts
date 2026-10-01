/**
 * Ordered, append-only schema migrations. Never edit an applied migration;
 * add a new one. Embedded as strings so the compiled build has no asset step.
 */
export interface Migration {
  id: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: "0001_provenance_ledger",
    sql: /* sql */ `
-- ── Raw provenance ──────────────────────────────────────────────────────────
create table source_documents (
  id            text primary key check (id ~ '^[0-9a-f]{64}$'),
  source        text not null,
  url           text not null,
  content_type  text,
  byte_length   integer not null check (byte_length >= 0),
  encoding      text not null check (encoding in ('gzip', 'identity')),
  body          bytea not null,
  fetched_at    timestamptz not null
);

create table ingest_runs (
  id           text primary key,
  started_at   timestamptz not null,
  finished_at  timestamptz,
  status       text not null check (status in ('running', 'succeeded', 'partial', 'failed')),
  report       jsonb
);
create index ingest_runs_started_idx on ingest_runs (started_at desc);

create table fetch_log (
  id           text primary key,
  run_id       text not null references ingest_runs (id),
  source       text not null,
  url          text not null,
  started_at   timestamptz not null,
  finished_at  timestamptz not null,
  http_status  integer,
  document_id  text references source_documents (id),
  error        text,
  check ((document_id is null) <> (error is null))
);
create index fetch_log_document_idx on fetch_log (document_id);
create index fetch_log_run_idx on fetch_log (run_id);

-- ── State ledger ────────────────────────────────────────────────────────────
-- legal_objects is a projection: the fold of legal_events per state_key.
create table legal_objects (
  state_key           text primary key,
  source              text not null,
  domain              text not null,
  title               text not null,
  instrument          text,
  current_state       text not null,
  fingerprint         text not null,
  revision            integer not null check (revision >= 0),
  current_event_id    text not null,
  procedural_stage    text,
  state_published_at  timestamptz,
  first_seen_at       timestamptz not null,
  last_changed_at     timestamptz not null,
  last_observed_at    timestamptz not null,
  observation_count   integer not null check (observation_count >= 1)
);

create table legal_events (
  id                           text primary key,
  kind                         text not null check (kind in ('baseline', 'transition', 'occurrence')),
  state_key                    text not null references legal_objects (state_key) deferrable initially deferred,
  revision                     integer not null check (revision >= 0),
  source                       text not null,
  domain                       text not null,
  title                        text not null,
  summary                      text not null,
  actors                       text[] not null,
  instrument                   text,
  action                       text not null,
  previous_state               text,
  previous_fingerprint         text,
  previous_state_published_at  timestamptz,
  previous_procedural_stage    text,
  new_state                    text not null,
  fingerprint                  text not null,
  state_published_at           timestamptz,
  procedural_stage             text,
  next_expected_stage          text,
  significance                 text not null check (significance in ('routine', 'notable', 'major')),
  observed_at                  timestamptz not null,
  unique (state_key, revision),
  check ((kind = 'transition') = (previous_fingerprint is not null)),
  check ((kind = 'transition') = (revision > 0))
);
create index legal_events_observed_idx on legal_events (observed_at desc, id);
create index legal_events_kind_observed_idx on legal_events (kind, observed_at desc);

alter table legal_objects
  add constraint legal_objects_current_event_fk
  foreign key (current_event_id) references legal_events (id) deferrable initially deferred;

create table citations (
  id            text primary key,
  event_id      text not null references legal_events (id),
  document_id   text not null references source_documents (id),
  locator       text not null check (locator like '/%'),
  url           text not null check (url like 'https://%'),
  title         text not null,
  publisher     text not null,
  excerpt       text not null,
  published_at  timestamptz,
  retrieved_at  timestamptz not null
);
create index citations_event_idx on citations (event_id);
create index citations_document_idx on citations (document_id);

create table event_claims (
  event_id  text not null references legal_events (id),
  field     text not null check (field in ('newState', 'previousState', 'action', 'difference', 'nextExpectedStage')),
  value     text not null,
  basis     text not null check (basis in ('source', 'derived', 'inferred')),
  rule      text,
  primary key (event_id, field),
  check (basis = 'source' or rule is not null)
);

create table claim_citations (
  event_id     text not null,
  field        text not null,
  ordinal      integer not null check (ordinal >= 0),
  citation_id  text not null references citations (id),
  primary key (event_id, field, ordinal),
  unique (event_id, field, citation_id),
  foreign key (event_id, field) references event_claims (event_id, field)
);

-- ── Broadcast artifacts ─────────────────────────────────────────────────────
create table briefings (
  id            text primary key,
  mode          text not null,
  title         text not null,
  created_at    timestamptz not null,
  window_start  timestamptz,
  window_end    timestamptz not null,
  script        text not null,
  segments      jsonb not null,
  event_ids     text[] not null,
  citation_ids  text[] not null,
  audio         jsonb,
  check (window_start is null or window_start < window_end)
);
create index briefings_mode_created_idx on briefings (mode, created_at desc, id desc);

-- ── Immutability of the provenance ledger ───────────────────────────────────
create function docket_forbid_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'table % is append-only (% rejected)', tg_table_name, tg_op
    using errcode = 'restrict_violation';
end
$$;

create trigger source_documents_immutable before update or delete on source_documents
  for each row execute function docket_forbid_mutation();
create trigger legal_events_immutable before update or delete on legal_events
  for each row execute function docket_forbid_mutation();
create trigger citations_immutable before update or delete on citations
  for each row execute function docket_forbid_mutation();
create trigger event_claims_immutable before update or delete on event_claims
  for each row execute function docket_forbid_mutation();
create trigger claim_citations_immutable before update or delete on claim_citations
  for each row execute function docket_forbid_mutation();
`
  }
];
