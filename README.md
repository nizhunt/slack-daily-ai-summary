# Slack Daily Summary

> 🤖 Export your Slack conversations to clean Markdown and get AI-powered summaries delivered to your Obsidian vault.

Slack AI costs **$10/user/month**. This open-source alternative gives you the same summarization power using Google Gemini's generous free tier, with the added benefit of owning your data in your personal knowledge base.

## ✨ Features

- **📥 Full Export**: Fetches messages from public channels, private channels, DMs, and group DMs
- **🧵 Thread Support**: Recursively expands thread replies so you don't miss context
- **🧹 Clean Markdown**: Strips Slack-specific formatting, resolves user IDs to names
- **🤖 AI Summarization**: Uses Google Gemini to generate actionable summaries
- **📔 Obsidian Integration**: Automatically saves summaries to your Obsidian vault
- **🔄 Daily & Weekly Modes**: Export a single day or the entire week
- **⏰ Scheduled Runs**: Includes macOS LaunchAgent template for automation

## 🚀 Quick Start

### Prerequisites

- **Node.js** v18 or higher
- **Slack User Token** (see [Setup Slack Token](#-setup-slack-token))
- **Google Gemini API Key** (free tier available)

### Installation

```bash
# Clone the repository
git clone https://github.com/YOUR_USERNAME/slack-daily-summary.git
cd slack-daily-summary

# Install dependencies
npm install

# Copy the example environment file
cp .env.example .env
```

### Configuration

Edit `.env` with your credentials:

```bash
# Required
SLACK_USER_TOKEN=xoxp-your-token-here
GEMINI_API_KEY=your-gemini-api-key-here

# Optional
SLACK_BLACKLIST=Slackbot,noisy-channel
TZ=America/New_York

# For weekly workflow (Obsidian integration)
ARCHIVE_DIR=/path/to/your/archive
JOURNAL_DIR=/path/to/obsidian/vault/Journal/Weekly
```

### Run

```bash
# Export yesterday's messages
node export-slack-day.mjs

# Export a specific date
node export-slack-day.mjs --date 2024-01-15

# Export the last 7 days
node export-slack-day.mjs --weekly

# Run with debug logging
node export-slack-day.mjs --debug
```

---

## 🔐 Setup Slack Token

This script requires a **Slack User Token** (starts with `xoxp-`) to access your conversations. Here's how to create one:

### Step 1: Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click **"Create New App"**
3. Choose **"From scratch"**
4. Name your app (e.g., "Daily Summary Exporter")
5. Select your workspace

### Step 2: Configure OAuth Scopes

Navigate to **OAuth & Permissions** in the sidebar and add the following **User Token Scopes**:

| Scope | Purpose |
|-------|---------|
| `users:read` | Resolve user IDs to display names |
| `channels:read` | List public channels |
| `channels:history` | Read public channel messages |
| `groups:read` | List private channels |
| `groups:history` | Read private channel messages |
| `im:read` | List direct messages |
| `im:history` | Read direct messages |
| `mpim:read` | List group DMs |
| `mpim:history` | Read group DM messages |

### Step 3: Install the App

1. Scroll up to **OAuth Tokens for Your Workspace**
2. Click **"Install to Workspace"**
3. Review permissions and click **"Allow"**
4. Copy the **User OAuth Token** (starts with `xoxp-`)

### Step 4: Add to Environment

```bash
# In your .env file
SLACK_USER_TOKEN=xoxp-your-token-here
```

> ⚠️ **Security Note**: Never commit your `.env` file. The token grants access to all conversations you're a member of.

---

## 🧠 Setup Gemini API

The AI summarization uses Google's Gemini API:

1. Go to [Google AI Studio](https://aistudio.google.com/apikey)
2. Click **"Create API Key"**
3. Copy the key and add to your `.env`:

```bash
GEMINI_API_KEY=your-key-here
```

The script uses `gemini-3-flash-preview` which is fast and cost-effective.

---

## 📁 Output Files

| File | Description |
|------|-------------|
| `export-YYYY-MM-DD.md` | Raw messages in clean Markdown |
| `summary-YYYY-MM-DD.md` | AI-generated summary |
| `export-weekly-YYYY-MM-DD.md` | Weekly raw export |
| `summary-weekly-YYYY-MM-DD.md` | Weekly AI summary |

---

## 📅 Automated Weekly Workflow

The `weekly-workflow.mjs` script orchestrates a complete weekly export:

1. Runs `export-slack-day.mjs --weekly`
2. Moves raw export to your archive folder
3. Appends the summary to your Obsidian journal

### Configure Paths

In your `.env`:

```bash
ARCHIVE_DIR=/Users/you/Documents/Slack Archives
JOURNAL_DIR=/Users/you/Obsidian/Notes/Journal/Weekly
```

### Manual Run

```bash
node weekly-workflow.mjs

# Or with a specific date
node weekly-workflow.mjs --date 2024-01-19
```

### Schedule on macOS

Use the included LaunchAgent template:

```bash
# Copy the template
cp com.example.slack-weekly.plist.example ~/Library/LaunchAgents/com.yourname.slack-weekly.plist

# Edit with your paths (change paths pointed by <string> tags)
nano ~/Library/LaunchAgents/com.yourname.slack-weekly.plist

# Load the agent
launchctl load ~/Library/LaunchAgents/com.yourname.slack-weekly.plist
```

The default schedule runs **every Friday at 8:00 PM**.

### Schedule on Linux (cron)

```bash
# Edit crontab
crontab -e

# Add this line (Friday 8 PM)
0 20 * * 5 cd /path/to/slack-daily-summary && /usr/bin/node weekly-workflow.mjs >> weekly.log 2>&1
```

---

## 🎨 Customizing the Summary Prompt

Edit `prompt.md` to change how the AI summarizes your messages. The default prompt acts as a "ruthless Chief of Staff" extracting:

- **TL;DR**: 3 bullet summary
- **Decisions**: Key decisions with evidence
- **Actions**: Owner-attributed tasks
- **Risks/Blocks**: Issues needing attention
- **Open Loops**: Unresolved questions

---

## 🛠️ CLI Reference

```
Usage: node export-slack-day.mjs [options]

Options:
  -d, --date       Date to export (YYYY-MM-DD). Defaults to yesterday.
  -t, --tz         Timezone (default: Asia/Kolkata)
  -o, --output     Output file path (default: export-{date}.md)
  -b, --blacklist  Comma-separated channels/users to skip
  -w, --weekly     Export last 7 days instead of single day
  --debug          Enable verbose logging
  --help           Show help
```

---

## 📊 Telemetry

Each run outputs a summary:

```
=== Export Summary ===
Run ID: a1b2c3d4e5f6g7h8
Date: 2024-01-15 (Asia/Kolkata)
Conversations processed: 42
Messages exported: 387
Threads expanded: 23
API calls made: 156
Rate limit waits: 0
Duration: 12.34s
Errors: None
======================
```

---

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

---

## 📄 License

MIT License - feel free to use this for personal or commercial projects.

---

## 💡 Why I Built This

Slack AI costs $10/user/month as a mandatory add-on. For a 20-person team, that's $2,400/year just to summarize conversations. I wanted:

1. **Cost savings**: Using Gemini's free tier instead
2. **Data ownership**: Summaries in my Obsidian vault, not trapped in Slack
3. **Customization**: My own prompt engineering for decision-grade briefs

Read more about the motivation on [LinkedIn](#).
