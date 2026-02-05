import 'dotenv/config';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { WebClient } from '@slack/web-api';
import { format, subDays } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { GoogleGenerativeAI } from '@google/generative-ai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============ Telemetry & Logging ============
const runId = crypto.randomBytes(8).toString('hex');
const telemetry = {
    conversationsProcessed: 0,
    messagesExported: 0,
    threadsExpanded: 0,
    rateLimitWaits: 0,
    apiCalls: 0,
    errors: []
};
const startTime = Date.now();

// Logging levels and debug mode
let DEBUG_MODE = false;

function log(level, context, message, data = null) {
    const timestamp = new Date().toISOString();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    const prefix = `[${timestamp}] [${elapsed}s] [${runId}] [${level}]`;

    let logLine = `${prefix} [${context}] ${message}`;

    if (data !== null && DEBUG_MODE) {
        // Redact sensitive data
        const safeData = redactSensitive(data);
        logLine += ` | Data: ${JSON.stringify(safeData, null, 0)}`;
    }

    console.error(logLine);
}

function debug(context, message, data = null) {
    if (DEBUG_MODE) {
        log('DEBUG', context, message, data);
    }
}

function info(context, message, data = null) {
    log('INFO', context, message, data);
}

function warn(context, message, data = null) {
    log('WARN', context, message, data);
}

function error(context, message, data = null) {
    log('ERROR', context, message, data);
    if (data?.error) {
        telemetry.errors.push(`[${context}] ${message}: ${data.error}`);
    } else {
        telemetry.errors.push(`[${context}] ${message}`);
    }
}

function redactSensitive(obj) {
    if (typeof obj !== 'object' || obj === null) return obj;

    const redacted = Array.isArray(obj) ? [...obj] : { ...obj };
    const sensitiveKeys = ['token', 'authorization', 'password', 'secret', 'key', 'text', 'message'];

    for (const key of Object.keys(redacted)) {
        if (sensitiveKeys.some(s => key.toLowerCase().includes(s))) {
            if (typeof redacted[key] === 'string' && redacted[key].length > 10) {
                redacted[key] = redacted[key].substring(0, 4) + '...[REDACTED]';
            }
        } else if (typeof redacted[key] === 'object') {
            redacted[key] = redactSensitive(redacted[key]);
        }
    }
    return redacted;
}

// Helper to get previous calendar day in timezone
function getPreviousDay(tz) {
    debug('getPreviousDay', `Calculating previous day for timezone: ${tz}`);
    const now = new Date();
    debug('getPreviousDay', `Current UTC time: ${now.toISOString()}`);

    const nowInTz = toZonedTime(now, tz);
    debug('getPreviousDay', `Time in ${tz}: ${nowInTz.toISOString()}`);

    const yesterday = subDays(nowInTz, 1);
    const result = format(yesterday, 'yyyy-MM-dd');
    debug('getPreviousDay', `Previous day calculated: ${result}`);

    return result;
}

// Helper to get current day in timezone
function getToday(tz) {
    debug('getToday', `Calculating current day for timezone: ${tz}`);
    const now = new Date();
    const nowInTz = toZonedTime(now, tz);
    const result = format(nowInTz, 'yyyy-MM-dd');
    debug('getToday', `Current day calculated: ${result}`);
    return result;
}

const argv = yargs(hideBin(process.argv))
    .option('date', {
        alias: 'd',
        type: 'string',
        description: 'Date to export (YYYY-MM-DD). Defaults to previous calendar day.',
    })
    .option('tz', {
        alias: 't',
        type: 'string',
        description: 'Timezone',
        default: 'Asia/Kolkata'
    })
    .option('token', {
        alias: 'k',
        type: 'string',
        description: 'Slack User Token (xoxp-...)',
    })
    .option('output', {
        alias: 'o',
        type: 'string',
        description: 'Output file path. If not provided, outputs to stdout.',
    })
    .option('debug', {
        type: 'boolean',
        description: 'Enable verbose debug logging',
        default: false
    })
    .option('blacklist', {
        alias: 'b',
        type: 'string',
        description: 'Comma-separated list of channel names or user names to skip',
    })
    .option('weekly', {
        alias: 'w',
        type: 'boolean',
        description: 'Export last 7 days instead of a single day',
        default: false
    })
    .help()
    .argv;

// Set debug mode
DEBUG_MODE = argv.debug;

info('init', `Debug mode: ${DEBUG_MODE ? 'ENABLED' : 'disabled'}`);
debug('init', 'Parsed command line arguments', {
    date: argv.date,
    tz: argv.tz,
    output: argv.output,
    tokenProvided: !!argv.token,
    envTokenProvided: !!process.env.SLACK_USER_TOKEN
});

const SLACK_TOKEN = argv.token || process.env.SLACK_USER_TOKEN;
const BLACKLIST = (argv.blacklist || process.env.SLACK_BLACKLIST || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (BLACKLIST.length > 0) {
    info('init', `Blacklist enabled: ${BLACKLIST.join(', ')}`);
}

if (!SLACK_TOKEN) {
    error('init', 'Slack User Token is required. Provide it via --token or SLACK_USER_TOKEN env variable.');
    process.exit(1);
}

// Validate token format
if (!SLACK_TOKEN.startsWith('xoxp-') && !SLACK_TOKEN.startsWith('xoxb-')) {
    warn('init', `Token does not start with expected prefix (xoxp- or xoxb-). Got: ${SLACK_TOKEN.substring(0, 5)}...`);
}

debug('init', `Token type: ${SLACK_TOKEN.substring(0, 4)}... (length: ${SLACK_TOKEN.length})`);

// Disable built-in retry - we handle rate limits manually with proper backoff
const client = new WebClient(SLACK_TOKEN, {
    retryConfig: {
        retries: 0,
    }
});

info('init', 'Slack WebClient initialized');

let userMap = new Map();

// Concurrency control: limit parallel API calls
const MAX_CONCURRENT_HISTORY = 3;
const MAX_CONCURRENT_REPLIES = 2;

debug('init', `Concurrency limits: history=${MAX_CONCURRENT_HISTORY}, replies=${MAX_CONCURRENT_REPLIES}`);

// Exponential backoff with jitter
async function sleepWithJitter(baseMs, attempt = 1) {
    const backoff = Math.min(baseMs * Math.pow(2, attempt - 1), 60000);
    const jitter = Math.random() * backoff * 0.3; // 30% jitter
    const total = Math.round(backoff + jitter);
    debug('sleepWithJitter', `Sleeping for ${total}ms (base=${baseMs}, attempt=${attempt}, backoff=${backoff}, jitter=${Math.round(jitter)})`);
    await new Promise(r => setTimeout(r, total));
}

async function retryableCall(fn, context, maxRetries = 5) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const callStart = Date.now();
        telemetry.apiCalls++;

        debug('retryableCall', `API call attempt ${attempt}/${maxRetries}`, { context, attemptNumber: attempt });

        try {
            const result = await fn();
            const duration = Date.now() - callStart;
            debug('retryableCall', `API call succeeded in ${duration}ms`, { context, duration, hasNextCursor: !!result?.response_metadata?.next_cursor });
            return result;
        } catch (e) {
            const duration = Date.now() - callStart;
            const errorInfo = {
                context,
                attempt,
                duration,
                errorCode: e.code,
                errorMessage: e.message,
                slackError: e.data?.error,
                httpStatus: e.status,
                retryAfter: e.headers?.['retry-after']
            };

            debug('retryableCall', `API call failed after ${duration}ms`, errorInfo);

            const isRateLimited = e.data?.error === 'ratelimited';
            const isNetworkError = e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT' || e.code === 'ENOTFOUND';
            const isServerError = e.status >= 500 && e.status < 600;

            if (isRateLimited) {
                telemetry.rateLimitWaits++;
                const retryAfter = parseInt(e.headers?.['retry-after'] || '1', 10);
                warn('retryableCall', `Rate limited (429). Waiting ${retryAfter}s before retry`, { context, retryAfter, attempt });
                await new Promise(r => setTimeout(r, retryAfter * 1000));
                continue;
            }

            if ((isNetworkError || isServerError) && attempt < maxRetries) {
                warn('retryableCall', `Transient error (${e.code || e.status}). Retrying with backoff...`, { context, attempt, maxRetries });
                await sleepWithJitter(1000, attempt);
                continue;
            }

            // Log detailed error info before throwing
            error('retryableCall', `API call failed permanently after ${attempt} attempts`, {
                context,
                errorCode: e.code,
                errorMessage: e.message,
                slackError: e.data?.error,
                slackErrorDetail: e.data?.response_metadata?.messages,
                httpStatus: e.status,
                stack: e.stack?.split('\n').slice(0, 3).join(' | ')
            });

            throw e;
        }
    }
}

async function main() {
    const tz = argv.tz;
    const date = argv.date || (argv.weekly ? getToday(tz) : getPreviousDay(tz));
    const output = argv.output || (argv.weekly ? `export-weekly-${date}.md` : `export-${date}.md`);

    info('main', '========== STARTING SLACK EXPORT ==========');
    info('main', `Run ID: ${runId}`);
    info('main', `Export date: ${date}`);
    info('main', `Timezone: ${tz}`);
    info('main', `Output: ${output || 'stdout'}`);

    try {
        // 0. Test API connectivity
        info('main', '[Step 0/5] Testing Slack API connectivity...');
        try {
            const authTest = await retryableCall(() => client.auth.test(), 'auth.test');
            info('main', `Connected to Slack workspace`, {
                team: authTest.team,
                user: authTest.user,
                userId: authTest.user_id,
                teamId: authTest.team_id
            });
        } catch (e) {
            error('main', 'Failed to connect to Slack API. Check your token.', {
                error: e.message,
                hint: 'Ensure token has required scopes: users:read, channels:read, channels:history, groups:read, groups:history, im:read, im:history, mpim:read, mpim:history'
            });
            throw e;
        }

        // 1. Build User Map
        info('main', '[Step 1/5] Fetching user list for name resolution...');
        userMap = await getUsersMap();
        info('main', `User map built: ${userMap.size} users resolved`);
        debug('main', 'Sample users', Array.from(userMap.entries()).slice(0, 3));

        // 2. Calculate Day Window
        info('main', '[Step 2/5] Calculating time window...');
        let startIso = `${date}T00:00:00`;
        const endIso = `${date}T23:59:59.999`;

        if (argv.weekly) {
            debug('main', 'Weekly mode enabled. Adjusting start date.');
            const endDateZoned = toZonedTime(fromZonedTime(endIso, tz), tz);
            const startDateZoned = subDays(endDateZoned, 6);
            startIso = `${format(startDateZoned, 'yyyy-MM-dd')}T00:00:00`;
            debug('main', `Weekly range: ${startIso} to ${endIso}`);
        }

        debug('main', `Local time strings: start=${startIso}, end=${endIso}`);

        const startDate = fromZonedTime(startIso, tz);
        const endDate = fromZonedTime(endIso, tz);
        const startEpoch = startDate.getTime() / 1000;
        const endEpoch = endDate.getTime() / 1000;

        info('main', `Time window calculated`, {
            startEpoch,
            endEpoch,
            startUTC: startDate.toISOString(),
            endUTC: endDate.toISOString(),
            durationHours: ((endEpoch - startEpoch) / 3600).toFixed(2)
        });

        // 3. Enumerate Conversations
        info('main', '[Step 3/5] Fetching conversations...');
        const conversations = await getAllConversations();

        const convBreakdown = {
            total: conversations.length,
            public_channel: conversations.filter(c => c.is_channel && !c.is_private).length,
            private_channel: conversations.filter(c => c.is_channel && c.is_private).length,
            im: conversations.filter(c => c.is_im).length,
            mpim: conversations.filter(c => c.is_mpim || c.is_group).length
        };
        info('main', `Found ${conversations.length} conversations`, convBreakdown);

        // 4. Process Each Conversation with concurrency control
        info('main', '[Step 4/5] Processing conversations and fetching messages...');
        const exportData = [];
        let processedCount = 0;
        const totalConversations = conversations.length;

        // Process in batches for concurrency control
        for (let i = 0; i < conversations.length; i += MAX_CONCURRENT_HISTORY) {
            const batch = conversations.slice(i, i + MAX_CONCURRENT_HISTORY);
            const batchNum = Math.floor(i / MAX_CONCURRENT_HISTORY) + 1;
            const totalBatches = Math.ceil(conversations.length / MAX_CONCURRENT_HISTORY);

            debug('main', `Processing batch ${batchNum}/${totalBatches}`, {
                batchSize: batch.length,
                startIndex: i
            });

            const results = await Promise.all(batch.map(async (conv) => {
                const convLabel = getConversationLabel(conv);
                const convType = getConversationType(conv);

                if (BLACKLIST.includes(convLabel.toLowerCase()) || BLACKLIST.includes(conv.id.toLowerCase())) {
                    debug('main', `Skipping blacklisted conversation: ${convLabel} (${conv.id})`);
                    return null;
                }

                debug('getHistory', `Fetching history for conversation`, {
                    id: conv.id,
                    name: convLabel,
                    type: convType
                });

                const history = await getHistory(conv.id, startEpoch, endEpoch);
                processedCount++;

                if (history && history.length > 0) {
                    info('main', `[${processedCount}/${totalConversations}] ${convLabel}: ${history.length} messages found`);
                    telemetry.conversationsProcessed++;
                    telemetry.messagesExported += history.length;

                    // Analyze message types
                    const messageStats = {
                        total: history.length,
                        withThreads: history.filter(m => m.reply_count > 0).length,
                        fromBots: history.filter(m => m.bot_id).length,
                        withAttachments: history.filter(m => m.files?.length > 0).length
                    };
                    debug('main', `Message stats for ${convLabel}`, messageStats);

                    // Fetch threads
                    const enrichedMessages = await enrichWithThreads(conv.id, history, convLabel);
                    return {
                        conversation: conv,
                        messages: enrichedMessages
                    };
                } else {
                    debug('main', `[${processedCount}/${totalConversations}] ${convLabel}: No messages in time window`);
                }
                return null;
            }));

            exportData.push(...results.filter(Boolean));

            debug('main', `Batch ${batchNum} complete. Export data now has ${exportData.length} conversations with messages.`);
        }

        info('main', `Conversation processing complete`, {
            conversationsWithMessages: exportData.length,
            totalMessagesFound: telemetry.messagesExported,
            threadsExpanded: telemetry.threadsExpanded
        });

        // 5. Generate Markdown
        info('main', '[Step 5/5] Generating Markdown output...');
        const dateLabel = argv.weekly
            ? `${format(toZonedTime(startDate, tz), 'yyyy-MM-dd')} to ${date}`
            : date;
        const markdown = generateMarkdown(exportData, dateLabel, tz);

        info('main', `Markdown generated: ${markdown.length} characters`);

        // Output to file or stdout
        if (output) {
            debug('main', `Writing raw output to file: ${output}`);
            try {
                fs.writeFileSync(output, markdown, 'utf-8');
                info('main', `Raw output written to file: ${output}`, {
                    bytes: Buffer.byteLength(markdown, 'utf-8')
                });
            } catch (e) {
                error('main', `Failed to write output file`, {
                    path: output,
                    error: e.message,
                    code: e.code
                });
                throw e;
            }

            // Gemini Summarization
            if (GEMINI_API_KEY) {
                info('main', '[Step 6/6] Generating Gemini Summary...');
                try {
                    const promptPath = path.join(__dirname, 'prompt.md');
                    let promptTemplate = '';
                    try {
                        promptTemplate = fs.readFileSync(promptPath, 'utf-8');
                        debug('main', `Loaded prompt from ${promptPath}`);
                    } catch (e) {
                        warn('main', `Could not find prompt.md at ${promptPath}. Skipping summary.`);
                    }

                    if (promptTemplate) {
                        const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
                        const modelName = argv.weekly ? "gemini-3-flash-preview" : "gemini-3-flash-preview";
                        const model = genAI.getGenerativeModel({ model: modelName });
                        info('main', `Using model: ${modelName}`);

                        const fullPrompt = `${promptTemplate}\n\n${markdown}`;
                        info('main', 'Sending request to Gemini API...');

                        const result = await model.generateContent(fullPrompt);
                        const response = await result.response;
                        const summaryText = response.text();

                        const summaryFilename = argv.weekly
                            ? `summary-weekly-${date}.md`
                            : `summary-${date}.md`;

                        fs.writeFileSync(summaryFilename, summaryText, 'utf-8');
                        info('main', `Summary written to file: ${summaryFilename}`, {
                            bytes: Buffer.byteLength(summaryText, 'utf-8')
                        });
                    }
                } catch (e) {
                    error('main', 'Gemini summarization failed', {
                        error: e.message,
                        code: e.code,
                        stack: e.stack?.split('\n').slice(0, 3).join(' | ')
                    });
                    // Don't throw, just log error so raw export is preserved
                }
            } else {
                warn('main', 'GEMINI_API_KEY not found. Skipping summarization.');
            }

        } else {
            debug('main', 'Writing output to stdout');
            console.log(markdown);
        }

        // Print telemetry summary
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);

        info('main', '========== EXPORT COMPLETE ==========');
        console.error('\n=== Export Summary ===');
        console.error(`Run ID: ${runId}`);
        console.error(`Date: ${date} (${tz})`);
        console.error(`Time window: ${new Date(startEpoch * 1000).toISOString()} to ${new Date(endEpoch * 1000).toISOString()}`);
        console.error(`Conversations processed: ${telemetry.conversationsProcessed}`);
        console.error(`Messages exported: ${telemetry.messagesExported}`);
        console.error(`Threads expanded: ${telemetry.threadsExpanded}`);
        console.error(`API calls made: ${telemetry.apiCalls}`);
        console.error(`Rate limit waits: ${telemetry.rateLimitWaits}`);
        console.error(`Duration: ${duration}s`);
        if (telemetry.errors.length > 0) {
            console.error(`\nErrors encountered: ${telemetry.errors.length}`);
            telemetry.errors.forEach((e, i) => console.error(`  ${i + 1}. ${e}`));
        } else {
            console.error(`Errors: None`);
        }
        console.error('======================\n');

    } catch (err) {
        error('main', 'Export failed with unhandled error', {
            error: err.message,
            code: err.code,
            stack: err.stack?.split('\n').slice(0, 5).join(' | ')
        });

        console.error('\n=== EXPORT FAILED ===');
        console.error(`Run ID: ${runId}`);
        console.error(`Error: ${err.message}`);
        console.error(`Duration before failure: ${((Date.now() - startTime) / 1000).toFixed(2)}s`);
        console.error(`API calls made: ${telemetry.apiCalls}`);
        if (telemetry.errors.length > 0) {
            console.error(`\nError trail:`);
            telemetry.errors.forEach((e, i) => console.error(`  ${i + 1}. ${e}`));
        }
        console.error('=====================\n');

        process.exit(1);
    }
}

// Helpers

// Conversation type priority for deterministic ordering (PRD §7.6)
const CONV_TYPE_ORDER = {
    'public_channel': 0,
    'private_channel': 1,
    'mpim': 2,
    'im': 3
};

function getConversationType(conv) {
    if (conv.is_channel && !conv.is_private) return 'public_channel';
    if (conv.is_channel && conv.is_private) return 'private_channel';
    if (conv.is_group || conv.is_mpim) return 'mpim';
    if (conv.is_im) return 'im';
    return 'unknown';
}

function getConversationLabel(conv) {
    let name = conv.name;
    if (!name && conv.user) {
        name = resolveUser(conv.user);
    } else if (!name) {
        name = conv.id;
    }
    return name;
}

async function getUsersMap() {
    const map = new Map();
    let cursor = undefined;
    let pageCount = 0;

    debug('getUsersMap', 'Starting user list fetch');

    do {
        pageCount++;
        debug('getUsersMap', `Fetching page ${pageCount}`, { cursor: cursor ? cursor.substring(0, 20) + '...' : 'none' });

        try {
            const result = await retryableCall(
                () => client.users.list({ limit: 1000, cursor: cursor }),
                `users.list(page=${pageCount})`
            );

            const memberCount = result.members?.length || 0;
            debug('getUsersMap', `Page ${pageCount} returned ${memberCount} members`);

            if (result.members) {
                for (const m of result.members) {
                    map.set(m.id, m.real_name || m.name);
                }
            }

            cursor = result.response_metadata?.next_cursor;
            debug('getUsersMap', cursor ? `More pages available` : 'No more pages');

        } catch (e) {
            error('getUsersMap', `Failed to fetch users list on page ${pageCount}`, {
                error: e.message,
                code: e.code,
                slackError: e.data?.error
            });
            break; // Don't block everything if users.list fails (e.g. scopes)
        }
    } while (cursor);

    debug('getUsersMap', `User fetch complete: ${map.size} users in ${pageCount} pages`);
    return map;
}

function resolveUser(userId) {
    const resolved = userMap.get(userId);
    if (!resolved) {
        debug('resolveUser', `User ID ${userId} not found in map, using ID as fallback`);
    }
    return resolved || userId || 'Unknown';
}

async function getAllConversations() {
    let channels = [];
    let cursor = undefined;
    let pageCount = 0;

    debug('getAllConversations', 'Starting conversation enumeration');

    do {
        pageCount++;
        debug('getAllConversations', `Fetching page ${pageCount}`, {
            cursor: cursor ? cursor.substring(0, 20) + '...' : 'none'
        });

        try {
            const result = await retryableCall(
                () => client.users.conversations({
                    types: 'public_channel,private_channel,im,mpim',
                    limit: 1000,
                    cursor: cursor
                }),
                `users.conversations(page=${pageCount})`
            );

            const channelCount = result.channels?.length || 0;
            debug('getAllConversations', `Page ${pageCount} returned ${channelCount} conversations`);

            if (result.channels) {
                channels = channels.concat(result.channels);
            }
            cursor = result.response_metadata?.next_cursor;

        } catch (e) {
            error('getAllConversations', `Failed to fetch conversations on page ${pageCount}`, {
                error: e.message,
                code: e.code,
                slackError: e.data?.error,
                hint: 'Required scopes: channels:read, groups:read, im:read, mpim:read'
            });
            throw e;
        }
    } while (cursor);

    debug('getAllConversations', `Conversation fetch complete: ${channels.length} total in ${pageCount} pages`);
    return channels;
}

async function getHistory(channelId, oldest, latest) {
    let messages = [];
    let cursor = undefined;
    let pageCount = 0;

    debug('getHistory', `Starting history fetch for ${channelId}`, { oldest, latest });

    do {
        pageCount++;

        try {
            const result = await retryableCall(
                () => client.conversations.history({
                    channel: channelId,
                    oldest: oldest.toString(),
                    latest: latest.toString(),
                    limit: 1000,
                    cursor: cursor
                }),
                `conversations.history(${channelId}, page=${pageCount})`
            );

            const msgCount = result.messages?.length || 0;
            debug('getHistory', `Page ${pageCount} returned ${msgCount} messages for ${channelId}`);

            if (result.messages) {
                messages = messages.concat(result.messages);
            }
            cursor = result.response_metadata?.next_cursor;

        } catch (e) {
            error('getHistory', `Failed to fetch history for channel ${channelId}`, {
                error: e.message,
                code: e.code,
                slackError: e.data?.error,
                channelId,
                oldest,
                latest,
                hint: 'Required scopes: channels:history, groups:history, im:history, mpim:history'
            });
            return []; // Continue with other channels
        }
    } while (cursor);

    debug('getHistory', `History fetch complete for ${channelId}: ${messages.length} messages in ${pageCount} pages`);
    return messages;
}

async function enrichWithThreads(channelId, messages, convLabel) {
    // Find parent messages with replies
    const parentsWithReplies = messages.filter(
        msg => msg.thread_ts && msg.thread_ts === msg.ts && msg.reply_count && msg.reply_count > 0
    );

    if (parentsWithReplies.length === 0) {
        debug('enrichWithThreads', `No threads to expand in ${convLabel}`);
        return messages;
    }

    debug('enrichWithThreads', `Found ${parentsWithReplies.length} threads to expand in ${convLabel}`);

    // Fetch replies with concurrency control
    for (let i = 0; i < parentsWithReplies.length; i += MAX_CONCURRENT_REPLIES) {
        const batch = parentsWithReplies.slice(i, i + MAX_CONCURRENT_REPLIES);

        await Promise.all(batch.map(async (parentMsg) => {
            debug('enrichWithThreads', `Fetching thread replies`, {
                channelId,
                threadTs: parentMsg.ts,
                expectedReplies: parentMsg.reply_count
            });

            const replies = await getReplies(channelId, parentMsg.ts);
            parentMsg._replies = replies.filter(r => r.ts !== parentMsg.ts);

            debug('enrichWithThreads', `Thread expanded`, {
                threadTs: parentMsg.ts,
                repliesFound: parentMsg._replies.length,
                expectedReplies: parentMsg.reply_count
            });

            telemetry.threadsExpanded++;
        }));
    }

    return messages;
}

async function getReplies(channelId, ts) {
    let messages = [];
    let cursor = undefined;
    let pageCount = 0;

    debug('getReplies', `Starting replies fetch for thread ${ts} in ${channelId}`);

    do {
        pageCount++;

        try {
            const result = await retryableCall(
                () => client.conversations.replies({
                    channel: channelId,
                    ts: ts,
                    limit: 200,
                    cursor: cursor
                }),
                `conversations.replies(${channelId}, ${ts}, page=${pageCount})`
            );

            const replyCount = result.messages?.length || 0;
            debug('getReplies', `Page ${pageCount} returned ${replyCount} messages for thread ${ts}`);

            if (result.messages) {
                messages = messages.concat(result.messages);
            }
            cursor = result.response_metadata?.next_cursor;

        } catch (e) {
            error('getReplies', `Failed to fetch replies for thread ${ts}`, {
                error: e.message,
                code: e.code,
                slackError: e.data?.error,
                channelId,
                threadTs: ts
            });
            return messages;
        }
    } while (cursor);

    debug('getReplies', `Replies fetch complete for thread ${ts}: ${messages.length} messages`);
    return messages;
}

function generateMarkdown(data, date, tz) {
    debug('generateMarkdown', `Generating markdown for ${data.length} conversations`);

    let output = `# Slack export ${date} (${tz})\n\n`;

    // Sort conversations by type first, then by display name (PRD §7.6)
    const sortedGroups = data.map(g => {
        const displayName = getConversationLabel(g.conversation);
        const convType = getConversationType(g.conversation);
        const typeOrder = CONV_TYPE_ORDER[convType] ?? 99;
        return { ...g, displayName, convType, typeOrder };
    }).sort((a, b) => {
        // First sort by type order
        if (a.typeOrder !== b.typeOrder) {
            return a.typeOrder - b.typeOrder;
        }
        // Then by display name
        return a.displayName.localeCompare(b.displayName);
    });

    debug('generateMarkdown', `Sorted ${sortedGroups.length} groups for output`);

    for (const group of sortedGroups) {
        // Include type prefix for clarity
        const typeLabel = getTypeLabel(group.convType);
        output += `## ${typeLabel}${group.displayName}\n`;

        const sorted = group.messages.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));

        for (const msg of sorted) {
            const fullDate = format(new Date(parseFloat(msg.ts) * 1000), 'yyyy-MM-dd HH:mm');
            const user = resolveUser(msg.user || msg.bot_id);
            const text = cleanText(msg.text || '');

            output += `${fullDate} **${user}**: ${text}\n`;

            if (msg._replies) {
                const sortedReplies = msg._replies.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));
                for (const reply of sortedReplies) {
                    const rFullDate = format(new Date(parseFloat(reply.ts) * 1000), 'yyyy-MM-dd HH:mm');
                    const rUser = resolveUser(reply.user || reply.bot_id);
                    const rText = cleanText(reply.text || '');
                    output += `    ${rFullDate} **${rUser}**: ${rText}\n`;
                }
            }
        }
        output += '\n';
    }

    debug('generateMarkdown', `Markdown generation complete: ${output.length} characters`);
    return output;
}

function getTypeLabel(convType) {
    switch (convType) {
        case 'public_channel': return '#';
        case 'private_channel': return '🔒';
        case 'mpim': return '👥 ';
        case 'im': return '💬 ';
        default: return '';
    }
}

function cleanText(text) {
    // 1. Valid User Mentions: <@U123456> -> @Name
    let cleaned = text.replace(/<@(U[A-Z0-9]+)>/g, (match, id) => {
        return '@' + resolveUser(id);
    });

    // 2. Channel Mentions: <#C123445|general> -> #general
    cleaned = cleaned.replace(/<#(C[A-Z0-9]+)\|?([^>]+)?>/g, (match, id, name) => {
        return '#' + (name || id);
    });

    // 3. Links: <https://google.com|Google> -> [Google](https://google.com)
    cleaned = cleaned.replace(/<([^|>]+)\|([^>]+)>/g, '[$2]($1)');

    // 4. Raw Links: <https://google.com> -> https://google.com
    cleaned = cleaned.replace(/<([^>]+)>/g, '$1');

    // 5. Slack formatting to plain text (PRD §7.6)
    // Bold: *text* -> text (Slack uses single asterisks for bold)
    cleaned = cleaned.replace(/\*([^*]+)\*/g, '$1');

    // Italic: _text_ -> text
    cleaned = cleaned.replace(/_([^_]+)_/g, '$1');

    // Strikethrough: ~text~ -> text
    cleaned = cleaned.replace(/~([^~]+)~/g, '$1');

    // Inline code: `code` -> code
    cleaned = cleaned.replace(/`([^`]+)`/g, '$1');

    // Code blocks: ```code``` -> code
    cleaned = cleaned.replace(/```([^`]*)```/gs, '$1');

    // 6. Normalization: collapse whitespace, trim
    cleaned = cleaned.replace(/\s+/g, ' ').trim();

    return cleaned;
}

main();
