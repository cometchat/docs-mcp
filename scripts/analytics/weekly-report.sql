-- Weekly MCP usage report (ENG-37102) — HogQL, paste into PostHog → SQL.
-- All events are tagged source = 'docs-mcp'. distinct_id is the salted 'mcp:'
-- fingerprint of the client IP alone (clientInfo is only present in the
-- initialize body and cannot be reproduced per request). Consequences:
--   - two clients behind one NAT/office IP share a distinct_id;
--   - client_name/client_version live on mcp_session_started only, so any
--     per-client breakdown must group by session_id and pull the client with
--     any(properties.client_name) — see §3b.
--
-- Definitions (from the tracking brief):
--   install       = an initialize (mcp_session_started). The only signal MCP has.
--   client        = distinct fingerprint, capped at one per day before the
--                   weekly rollup (Claude reconnects constantly).
--   new client    = fingerprint whose first-ever event falls in the week.
--   active client = fingerprint with >= 2 tool calls in the week (Anthropic's bar).
--
-- Caveat to restate in every report: claude.ai / Desktop traffic shares
-- Anthropic egress IPs (is_anthropic_egress = true), so fingerprints collapse
-- there — those numbers are SESSIONS, not people. Claude Code arrives from
-- developer IPs and dedupes genuinely. Publish both, labelled.
--
-- Validate against the dev PostHog project before trusting prod numbers.

-- ── 1. Headline table: week × clients/new/active/tool calls ────────────────
WITH first_seen AS (
    SELECT distinct_id, min(timestamp) AS first_ts
    FROM events
    WHERE properties.source = 'docs-mcp'
    GROUP BY distinct_id
),
day_clients AS (                    -- one client per fingerprint per day
    SELECT toStartOfDay(timestamp) AS day, distinct_id
    FROM events
    WHERE event = 'mcp_session_started' AND properties.source = 'docs-mcp'
    GROUP BY day, distinct_id
),
weekly_calls AS (
    SELECT toStartOfWeek(timestamp) AS week, distinct_id,
           count() AS tool_calls
    FROM events
    WHERE event IN ('mcp_tool_called', 'mcp_tool_failed')
      AND properties.source = 'docs-mcp'
    GROUP BY week, distinct_id
)
SELECT
    toStartOfWeek(dc.day) AS week,
    count(DISTINCT dc.distinct_id) AS clients,
    count(DISTINCT if(toStartOfWeek(fs.first_ts) = toStartOfWeek(dc.day),
                      dc.distinct_id, NULL)) AS new_clients,
    count(DISTINCT if(wc.tool_calls >= 2, dc.distinct_id, NULL)) AS active_clients,
    sum(coalesce(wc.tool_calls, 0)) AS tool_calls
FROM day_clients dc
LEFT JOIN first_seen fs ON fs.distinct_id = dc.distinct_id
LEFT JOIN weekly_calls wc
       ON wc.distinct_id = dc.distinct_id AND wc.week = toStartOfWeek(dc.day)
GROUP BY week
ORDER BY week DESC;

-- ── 2. Client split: which agent connects (claude / cursor / codex / …) ────
-- Enumerate client_name values from real traffic; never hardcode a list.
SELECT
    toStartOfWeek(timestamp) AS week,
    properties.client_name AS client_name,
    properties.is_anthropic_egress AS anthropic_egress,
    count(DISTINCT distinct_id) AS clients,   -- sessions where egress = true
    count() AS sessions
FROM events
WHERE event = 'mcp_session_started' AND properties.source = 'docs-mcp'
GROUP BY week, client_name, anthropic_egress
ORDER BY week DESC, sessions DESC;

-- ── 3. Install-source attribution (?ref=) ──────────────────────────────────
SELECT
    toStartOfWeek(timestamp) AS week,
    coalesce(properties.ref, '(none)') AS ref,
    count(DISTINCT distinct_id) AS clients,
    count() AS sessions
FROM events
WHERE event = 'mcp_session_started' AND properties.source = 'docs-mcp'
GROUP BY week, ref
ORDER BY week DESC, sessions DESC;

-- ── 3b. Per-session behaviour — "did this Claude Code session get what it
--        came for?" Session duration and call counts are derived here rather
--        than emitted by the server: with a stateless, multi-replica server a
--        session's calls land on different pods, so no single process can
--        count them. The last event IS the session end.
SELECT
    properties.session_id                                    AS session_id,
    any(properties.client_name)                              AS client,
    any(properties.ref)                                      AS ref,
    countIf(event = 'mcp_tool_called')                       AS successful_calls,
    countIf(event = 'mcp_tool_failed')                       AS failed_calls,
    dateDiff('second', min(timestamp), max(timestamp))       AS session_seconds,
    groupUniqArray(properties.tool)                          AS tools_used,
    -- "got the desired output": at least one successful call and no failures
    countIf(event = 'mcp_tool_called') > 0
      AND countIf(event = 'mcp_tool_failed') = 0             AS clean_session
FROM events
WHERE properties.source = 'docs-mcp'
  AND properties.session_id IS NOT NULL
  AND timestamp > now() - INTERVAL 7 DAY
GROUP BY session_id
ORDER BY successful_calls DESC
LIMIT 100;

-- ── 4. Top implementation bundles (incl. misses = missing scenarios) ───────
SELECT
    properties.bundle_id AS bundle,
    countIf(event = 'mcp_tool_called') AS served,
    countIf(event = 'mcp_tool_failed') AS failed
FROM events
WHERE properties.source = 'docs-mcp'
  AND properties.bundle_id IS NOT NULL
GROUP BY bundle
ORDER BY served DESC;
