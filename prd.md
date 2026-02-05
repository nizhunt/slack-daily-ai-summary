# PRD: Daily Slack “Day Export” to Clean Markdown (User Token, Threads)

## 1) Overview
Build a backend service in JavaScript (Node.js) that runs daily and exports only the target day’s Slack messages into a single clean Markdown document, suitable for feeding into an LLM. The service uses a Slack **user token** (OAuth) at runtime, does not persist the token, and does not store raw message data after producing the Markdown output.

## 2) Goals
- Export messages for one calendar day across: public channels, private channels, DMs, and group DMs.
- Include thread replies under their parent messages.
- Produce deterministic, “clean” Markdown with stable ordering and minimal Slack markup noise.

## 3) Non-goals
- Real-time ingestion (Events API).
- Exporting content the user cannot access (for example private channels where the user is not a member).
- Long-term storage of messages (DB archiving).

## 4) Users and use cases
- A single Slack user wants a daily transcript of their accessible conversations for analysis and LLM summarization.
- A workflow/pipeline wants a daily Markdown artifact for downstream processing.

## 5) Slack API approach (Web API)
### 5.1 Required methods
1) users.conversations
- Purpose: list conversations accessible via membership for the calling user token.
- Filter: types=public_channel,private_channel,im,mpim.
- Pagination: cursor-based using response_metadata.next_cursor. (Cursor passed as `cursor` in next request.)
Source: Slack method docs state it “returns a list of all channel-like conversations accessible (via membership of the channel) to the user…”, and supports filtering by `types` and cursor pagination. [web:35]

2) conversations.history
- Purpose: fetch messages for each conversation within the day window.
- Time window: use `oldest` and `latest` (epoch seconds) to restrict to the day.
- Pagination: supports cursor-based pagination with response_metadata.next_cursor; also documents time-based paging using `has_more` + updating `latest` to the last message’s `ts`.
Source: Slack docs describe cursor pagination via response_metadata.next_cursor and parameters like `oldest`/`latest`, and note `has_more` behavior for time paging. [web:9]

3) conversations.replies
- Purpose: fetch thread replies for a given parent message (`ts`) inside a conversation.
- Pagination: cursor-based via response_metadata.next_cursor; limit under 1000, Slack recommends no more than 200 at a time.
Notes: replies endpoint returns the thread; handle pagination and merge into output under the parent; deduplicate parent if returned.
Source: Slack docs describe pagination and limits for conversations.replies. [web:29]

### 5.2 Scope requirements (high level)
Request the history and read scopes needed to list and read each conversation type (public, private, IM, MPIM). Your exact scope set must include the appropriate `*:read` scopes to enumerate conversations and `*:history` scopes to read messages; Slack notes that if you only have some scopes, you only receive those conversation types. [web:18]

## 6) Access and permissions
- The user token can only retrieve private conversations (private channels, DMs, group DMs) where the user is a member; it cannot access other users’ private conversations.
Source: users.conversations documentation explains private channel membership is restricted to shared membership for non-public channel types. [web:35]

## 7) Functional requirements
### 7.1 Scheduling
- Runs daily at a configurable time (default 00:15 in a configured timezone).
- By default exports the previous calendar day in that timezone.

### 7.2 Day window logic
- Compute dayStart and dayEnd in timezone, convert to epoch seconds.
- For Slack calls, use `oldest=dayStartEpochSeconds` and `latest=dayEndEpochSeconds`.
Source: conversations.history supports `oldest` and `latest` time boundaries. [web:9]

### 7.3 Conversation enumeration
- Call users.conversations with types=public_channel,private_channel,im,mpim.
- Paginate until next_cursor is empty.
Source: users.conversations supports `types` filtering and cursor pagination. [web:35]

### 7.4 Message export per conversation
- For each conversation ID:
  - Fetch messages for the day window using conversations.history.
  - Paginate until completion.
  - Normalize and render each message to Markdown.
Source: conversations.history supports cursor pagination and time windows. [web:9]

### 7.5 Thread inclusion
- Identify parent messages that have replies (for example via reply_count > 0 when present).
- For each parent, fetch thread using conversations.replies (channel + parent ts).
- Paginate replies, then render replies nested under the parent in Markdown.
Source: conversations.replies retrieves thread messages and supports cursor pagination. [web:29]

### 7.6 Output formatting (clean Markdown)
- Output a single Markdown document per run.
- Grouping: by conversation, then chronological within each conversation.
- Deterministic ordering:
  - Conversations sorted by type then display name (or id as fallback).
  - Messages sorted ascending by timestamp.
- Markdown format (suggested):
  - `# Slack export YYYY-MM-DD (TZ)`
  - For each conversation:
    - `## <conversation label>`
    - `- HH:MM <author>: <clean text>`
    - For threaded replies:
      - `  - HH:MM <author>: <clean text>`
- Normalization:
  - Trim excessive whitespace, collapse repeated blank lines.
  - Convert common Slack formatting to plain text where feasible.
  - Preserve timestamps and author identifiers.

### 7.7 Token handling (security)
- Token is provided at runtime (environment variable, secret manager, or interactive input).
- Must never log or persist the token.

## 8) Rate limits and resilience
- Implement a request wrapper:
  - If Slack responds 429, read `Retry-After` and sleep, then retry.
Source: Slack rate limit docs describe tiers and 429 retry behavior and emphasize pagination patterns. [web:21]
- Concurrency control:
  - Limit concurrent conversations.history calls.
  - Use especially conservative throughput for conversations.replies due to stricter limits described in method docs and rate-limit tiering. [web:29][web:21]
- Retries:
  - Network timeouts: exponential backoff with jitter.
  - Hard failures: record error details in logs (without token), continue exporting other conversations when possible.

## 9) Interfaces
### 9.1 CLI mode (minimum)
- Command:
  - `node export-slack-day.mjs --date 2026-02-02 --tz Asia/Kolkata --blacklist "Slackbot, Google Calendar"`
- Options:
  - `--date`, `-d`: Target date.
  - `--tz`, `-t`: Timezone.
  - `--blacklist`, `-b`: Comma-separated names or IDs to skip.
- Environment Variables:
  - `SLACK_USER_TOKEN`: Slack token.
  - `SLACK_BLACKLIST`: Default blacklist.
- Output:
  - Markdown to stdout (default) or to a specified file path.

### 9.2 Service mode (optional)
- HTTP endpoint (protected):
  - `POST /export/day` with `{ date, tz }`
- Returns Markdown payload (or streams it).

## 10) Telemetry and logs
- Log run id, date window, number of conversations processed, number of messages, number of threads expanded, number of 429 waits, duration.
- Do not log message bodies by default (optional debug flag that still redacts sensitive content).

## 11) Acceptance criteria
- Exports only messages within the day window for all conversation types the user token can access.
- Includes thread replies under parent messages.
- Produces stable output across re-runs for the same day.
- Handles pagination correctly using response_metadata.next_cursor for list/history/replies. [web:35][web:9][web:29]
- Handles rate limits and respects Retry-After. [web:21]


