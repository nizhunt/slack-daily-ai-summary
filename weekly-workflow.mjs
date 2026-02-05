import 'dotenv/config';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { format } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration - Uses environment variables with fallback to current directory
const CONFIG = {
    TZ: process.env.TZ || 'Asia/Kolkata',
    ARCHIVE_DIR: process.env.ARCHIVE_DIR || path.join(__dirname, 'archives'),
    JOURNAL_DIR: process.env.JOURNAL_DIR || path.join(__dirname, 'journal'),
    PROJECT_DIR: __dirname
};

// Logging
function log(message) {
    console.log(`[WeeklyWorkflow] ${new Date().toISOString()} - ${message}`);
}

function error(message) {
    console.error(`[WeeklyWorkflow] ${new Date().toISOString()} - ERROR: ${message}`);
}

async function main() {
    try {
        log('Starting weekly export workflow...');

        // 1. Calculate Dates
        const args = process.argv.slice(2);
        const dateArgIdx = args.indexOf('--date');
        let now = new Date();

        if (dateArgIdx !== -1 && args[dateArgIdx + 1]) {
            now = new Date(args[dateArgIdx + 1]);
            log(`Using manual date override: ${args[dateArgIdx + 1]}`);
        }

        const nowInTz = toZonedTime(now, CONFIG.TZ);
        const dateStr = format(nowInTz, 'yyyy-MM-dd');

        // ISO Week format: 2026-W06
        // 'RRRR' is ISO week-numbering year, 'II' is ISO week of year (pad with 0)
        const weekStr = format(nowInTz, "RRRR-'W'II");

        log(`Date: ${dateStr}, Week: ${weekStr}`);

        // 2. Define File Paths
        const exportFilename = `export-weekly-${dateStr}.md`;
        const summaryFilename = `summary-weekly-${dateStr}.md`;

        const rawExportPath = path.join(CONFIG.PROJECT_DIR, exportFilename);
        const summaryPath = path.join(CONFIG.PROJECT_DIR, summaryFilename);

        const targetArchivePath = path.join(CONFIG.ARCHIVE_DIR, exportFilename);
        const targetJournalPath = path.join(CONFIG.JOURNAL_DIR, `${weekStr}.md`);

        // 3. Ensure Directories Exist
        if (!fs.existsSync(CONFIG.ARCHIVE_DIR)) {
            log(`Archive directory not found, creating: ${CONFIG.ARCHIVE_DIR}`);
            fs.mkdirSync(CONFIG.ARCHIVE_DIR, { recursive: true });
        }
        if (!fs.existsSync(CONFIG.JOURNAL_DIR)) {
            log(`Journal directory not found, creating: ${CONFIG.JOURNAL_DIR}`);
            fs.mkdirSync(CONFIG.JOURNAL_DIR, { recursive: true });
        }

        // 4. Run Export Script
        log(`Running export-slack-day.mjs --weekly --date ${dateStr}...`);
        try {
            // Inherit stdio so we see logs, but we also want to catch errors
            execSync(`node export-slack-day.mjs --weekly --date "${dateStr}" --tz "${CONFIG.TZ}"`, {
                cwd: CONFIG.PROJECT_DIR,
                stdio: 'inherit',
                env: process.env // Pass current environment (important for tokens)
            });
        } catch (e) {
            error(`Export script failed: ${e.message}`);
            process.exit(1);
        }

        // 5. Move Raw Export to Archive
        if (fs.existsSync(rawExportPath)) {
            log(`Moving raw export to: ${targetArchivePath}`);
            fs.renameSync(rawExportPath, targetArchivePath);
        } else {
            error(`Expected raw export file not found: ${rawExportPath}`);
            // Don't exit yet, check if summary exists at least
        }

        // 6. Append Summary to Journal
        if (fs.existsSync(summaryPath)) {
            log(`Reading summary from: ${summaryPath}`);
            const summaryContent = fs.readFileSync(summaryPath, 'utf-8');

            // Prepare content to append
            // Add a header or separator if appending to existing file
            let contentToAppend = `\n\n## Weekly Summary (${dateStr})\n\n${summaryContent}`;

            if (fs.existsSync(targetJournalPath)) {
                log(`Appending summary to existing journal file: ${targetJournalPath}`);
                fs.appendFileSync(targetJournalPath, contentToAppend, 'utf-8');
            } else {
                log(`Creating new journal file: ${targetJournalPath}`);
                // If new file, maybe we don't need the leading newlines/header as much, or maybe we do to keep format consistent
                fs.writeFileSync(targetJournalPath, `# Week ${weekStr}\n${contentToAppend}`, 'utf-8');
            }

            // Cleanup local summary file
            log(`Cleaning up local summary file: ${summaryPath}`);
            fs.unlinkSync(summaryPath);
        } else {
            error(`Expected summary file not found: ${summaryPath}`);
        }

        log('Weekly workflow completed successfully.');

    } catch (err) {
        error(`Workflow failed: ${err.message}\n${err.stack}`);
        process.exit(1);
    }
}

main();
