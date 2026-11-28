'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');
const session = require('express-session');
const multer = require('multer');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { processVideo } = require('./worker');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, 'data');
const TEMP_DIR = path.join(__dirname, 'temp');
const QUEUE_FILE = path.join(DATA_DIR, 'queue.json');
const MAX_HISTORY = Math.max(20, Number(process.env.MAX_HISTORY || 100));

for (const dir of [DATA_DIR, TEMP_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
}

function loadQueue() {
    try {
        const data = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
        return Array.isArray(data) ? data : [];
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.error('Queue file error:', error.message);
        }
        return [];
    }
}

let jobs = loadQueue();

// A process restart cannot resume an FFmpeg/AI subprocess. Put interrupted
// processing jobs back into the queue so they can safely restart from download.
for (const job of jobs) {
    if (job.status === 'processing' || job.status === 'cancelling') {
        job.status = 'queued';
        job.stage = 'Waiting after server restart';
        job.progress = 0;
        job.subtitleStatus = {
            state: 'waiting',
            stage: 'Will restart with the job',
            detail: 'The previous process stopped during server restart.'
        };
        job.updatedAt = new Date().toISOString();
    }
}

function saveQueue() {
    const tempFile = `${QUEUE_FILE}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(jobs, null, 2));
    fs.renameSync(tempFile, QUEUE_FILE);
}

saveQueue();

const upload = multer({
    storage: multer.diskStorage({
        destination: TEMP_DIR,
        filename: (req, file, callback) => {
            const extension = path.extname(file.originalname).toLowerCase();
            if (!['.srt', '.vtt'].includes(extension)) {
                return callback(Object.assign(
                    new Error('Subtitle files must be .srt or .vtt.'),
                    { status: 400 }
                ));
            }
            callback(null, `${randomUUID()}${extension}`);
        }
    }),
    limits: {
        files: 20,
        fields: 30,
        fileSize: 50 * 1024 * 1024
    }
});

if (!process.env.SESSION_SECRET) {
    console.error('SESSION_SECRET is missing from .env. Set it before starting the server.');
    process.exit(1);
}

app.set('trust proxy', Number(process.env.TRUST_PROXY || 1));
app.use(session({
    name: 'tipiz.sid',
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.COOKIE_SECURE === 'true',
        maxAge: 24 * 60 * 60 * 1000
    }
}));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// LOGIN
app.post('/login', (req, res) => {
    const { username, password } = req.body || {};
    if (
        process.env.ADMIN_USERNAME &&
        process.env.ADMIN_PASSWORD &&
        username === process.env.ADMIN_USERNAME &&
        password === process.env.ADMIN_PASSWORD
    ) {
        req.session.isLoggedIn = true;
        return req.session.save(() => res.redirect('/'));
    }
    res.redirect('/login.html?error=1');
});

// LOGOUT
app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login.html'));
});

// AUTHENTICATION
app.use((req, res, next) => {
    if (req.path === '/login.html' || req.path === '/login') return next();
    if (req.session?.isLoggedIn) return next();

    if (req.path.startsWith('/api/')) {
        return res.status(401).json({
            ok: false,
            error: 'Session expired. Please log in again.'
        });
    }
    return res.redirect('/login.html');
});

app.use(express.static(path.join(__dirname, 'public')));

// ========================================
// PERSISTENT QUEUE
// ========================================

let workerRunning = false;
let shuttingDown = false;
const activeControllers = new Map();

function publicJob(job) {
    const {
        subtitle1,
        subtitle2,
        url,
        ...safe
    } = job;
    return safe;
}

function updateJob(id, patch) {
    const job = jobs.find(item => item.id === id);
    if (!job) return null;
    Object.assign(job, patch, {
        updatedAt: new Date().toISOString()
    });
    saveQueue();
    return job;
}

function removeFile(filePath) {
    if (!filePath) return;
    try {
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            fs.unlinkSync(filePath);
        }
    } catch (error) {
        console.warn(`Could not remove temp file ${filePath}:`, error.message);
    }
}

function cleanupJobFiles(job) {
    removeFile(job?.subtitle1);
    removeFile(job?.subtitle2);
}

function isCancellation(error, controller) {
    return Boolean(
        controller?.signal.aborted ||
        error?.name === 'AbortError' ||
        error?.code === 'ABORT_ERR' ||
        error?.code === 'ERR_CANCELED'
    );
}

async function runQueue() {
    if (workerRunning || shuttingDown) return;
    workerRunning = true;

    try {
        while (true) {
            if (shuttingDown) break;
            const job = jobs.find(item => item.status === 'queued');
            if (!job) break;

            const controller = new AbortController();
            activeControllers.set(job.id, controller);

            updateJob(job.id, {
                status: 'processing',
                stage: 'Starting',
                progress: 0,
                error: null,
                startedAt: new Date().toISOString(),
                subtitleStatus: {
                    state: 'waiting',
                    stage: 'Waiting for subtitle checks',
                    detail: 'The worker will validate uploaded subtitles first.'
                }
            });

            let lastWriteAt = 0;
            let lastStage = '';

            const report = (stage, progress, extra = {}) => {
                const now = Date.now();
                const rounded = Number.isFinite(progress)
                    ? Math.max(0, Math.min(99, Math.round(progress)))
                    : null;

                if (
                    stage === lastStage &&
                    now - lastWriteAt < 900 &&
                    extra.detail === undefined
                ) {
                    return;
                }

                lastWriteAt = now;
                lastStage = stage;
                updateJob(job.id, {
                    stage,
                    progress: rounded,
                    ...extra
                });
            };

            const reportSubtitle = subtitleStatus => {
                updateJob(job.id, { subtitleStatus });
            };

            try {
                await processVideo({
                    ...job,
                    signal: controller.signal,
                    updateStatus: report,
                    updateSubtitleStatus: reportSubtitle
                });

                if (controller.signal.aborted) {
                    updateJob(job.id, {
                        status: 'cancelled',
                        stage: 'Cancelled',
                        progress: null,
                        error: 'Cancelled by administrator.',
                        cancelledAt: new Date().toISOString()
                    });
                    cleanupJobFiles(job);
                } else {
                    updateJob(job.id, {
                        status: 'completed',
                        stage: 'Completed',
                        progress: 100,
                        completedAt: new Date().toISOString(),
                        error: null
                    });
                }

            } catch (error) {
                if (isCancellation(error, controller)) {
                    if (shuttingDown) {
                        // Preserve the job and uploaded subtitles for automatic retry after PM2 restart.
                        updateJob(job.id, {
                            status: 'queued',
                            stage: 'Interrupted by server restart — queued again',
                            progress: 0,
                            error: null
                        });
                    } else {
                        console.log(`Job ${job.id} was cancelled.`);
                        updateJob(job.id, {
                            status: 'cancelled',
                            stage: 'Cancelled',
                            progress: null,
                            error: 'Cancelled by administrator.',
                            cancelledAt: new Date().toISOString()
                        });
                        cleanupJobFiles(job);
                    }
                } else {
                    console.error(`Job ${job.id} failed:`, error);
                    updateJob(job.id, {
                        status: 'failed',
                        stage: 'Failed',
                        progress: null,
                        error: String(error.message || error).slice(0, 1800),
                        failedAt: new Date().toISOString()
                    });
                }
            } finally {
                activeControllers.delete(job.id);
            }

            const finished = jobs.filter(item =>
                ['completed', 'failed', 'cancelled'].includes(item.status)
            );

            if (finished.length > MAX_HISTORY) {
                const removeIds = new Set(
                    finished
                        .slice(0, finished.length - MAX_HISTORY)
                        .map(item => item.id)
                );
                for (const oldJob of jobs.filter(item => removeIds.has(item.id))) {
                    cleanupJobFiles(oldJob);
                }
                jobs = jobs.filter(item => !removeIds.has(item.id));
                saveQueue();
            }
        }
    } finally {
        workerRunning = false;
        if (!shuttingDown && jobs.some(item => item.status === 'queued')) {
            setImmediate(runQueue);
        }
    }
}

// ========================================
// ADD VIDEO BATCH
// ========================================

app.post('/api/process-batch', upload.any(), (req, res) => {
    let titles;
    let urls;

    const receivedFiles = req.files || [];
    const discardReceivedFiles = () => receivedFiles.forEach(file => removeFile(file.path));

    try {
        titles = JSON.parse(req.body.titles);
        urls = JSON.parse(req.body.urls);
    } catch (_) {
        discardReceivedFiles();
        return res.status(400).json({ ok: false, error: 'Invalid batch data.' });
    }

    if (
        !Array.isArray(titles) ||
        !Array.isArray(urls) ||
        titles.length < 1 ||
        titles.length > 10 ||
        titles.length !== urls.length
    ) {
        discardReceivedFiles();
        return res.status(400).json({
            ok: false,
            error: 'A batch must contain 1-10 matching titles and URLs.'
        });
    }

    for (let index = 0; index < titles.length; index++) {
        if (
            typeof titles[index] !== 'string' ||
            !titles[index].trim() ||
            titles[index].length > 300 ||
            typeof urls[index] !== 'string' ||
            !/^https?:\/\//i.test(urls[index])
        ) {
            discardReceivedFiles();
            return res.status(400).json({
                ok: false,
                error: 'Every job needs a title and valid HTTP/HTTPS URL.'
            });
        }
    }

    const filesMap = {};
    for (const file of receivedFiles) {
        if (filesMap[file.fieldname]) {
            discardReceivedFiles();
            return res.status(400).json({ ok: false, error: 'Duplicate subtitle upload field.' });
        }
        filesMap[file.fieldname] = file.path;
    }

    const added = [];
    for (let index = 0; index < titles.length; index++) {
        const job = {
            id: randomUUID(),
            title: titles[index].trim(),
            url: urls[index].trim(),
            subtitle1: filesMap[`sub1_${index}`] || null,
            subtitle2: filesMap[`sub2_${index}`] || null,
            status: 'queued',
            stage: 'Waiting in queue',
            progress: 0,
            subtitleStatus: {
                state: 'waiting',
                stage: 'Waiting for processing',
                detail: 'Uploaded subtitle files will be validated; missing tracks can be generated locally.'
            },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            error: null
        };
        jobs.push(job);
        added.push(job.id);
    }

    // If any uploaded file field does not match a batch row, do not leave it behind.
    const allowedFields = new Set(titles.flatMap((_, index) => [`sub1_${index}`, `sub2_${index}`]));
    for (const file of receivedFiles) {
        if (!allowedFields.has(file.fieldname)) removeFile(file.path);
    }

    saveQueue();
    res.json({
        ok: true,
        message: `${added.length} job(s) added to queue.`,
        ids: added
    });
    setImmediate(runQueue);
});

// ========================================
// QUEUE STATUS
// ========================================

app.get('/api/status', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(jobs.map(publicJob));
});

// ========================================
// RETRY FAILED JOB
// ========================================

app.post('/api/jobs/:id/retry', (req, res) => {
    const job = jobs.find(item => item.id === req.params.id);
    if (!job) return res.status(404).json({ ok: false, error: 'Job not found.' });
    if (job.status !== 'failed') {
        return res.status(409).json({ ok: false, error: 'Only failed jobs can be retried.' });
    }

    updateJob(job.id, {
        status: 'queued',
        stage: 'Waiting for retry',
        progress: 0,
        error: null,
        startedAt: null,
        failedAt: null,
        subtitleStatus: {
            state: 'waiting',
            stage: 'Retry queued',
            detail: 'The video and missing subtitles will be processed again.'
        }
    });

    setImmediate(runQueue);
    res.json({ ok: true });
});

// ========================================
// CANCEL JOB
// ========================================

app.post('/api/jobs/:id/cancel', (req, res) => {
    const job = jobs.find(item => item.id === req.params.id);
    if (!job) return res.status(404).json({ ok: false, error: 'Job not found.' });

    if (job.status === 'queued') {
        updateJob(job.id, {
            status: 'cancelled',
            stage: 'Cancelled before starting',
            progress: null,
            error: 'Cancelled by administrator.',
            cancelledAt: new Date().toISOString()
        });
        cleanupJobFiles(job);
        job.subtitle1 = null;
        job.subtitle2 = null;
        saveQueue();
        return res.json({ ok: true, message: 'Queued job cancelled.' });
    }

    if (job.status !== 'processing' && job.status !== 'cancelling') {
        return res.status(409).json({ ok: false, error: 'This job is not running.' });
    }

    updateJob(job.id, {
        status: 'cancelling',
        stage: 'Cancelling processes…'
    });

    const controller = activeControllers.get(job.id);
    if (controller && !controller.signal.aborted) controller.abort();

    res.json({ ok: true, message: 'Cancellation requested.' });
});

// ========================================
// DELETE A SINGLE JOB
// ========================================

app.delete('/api/jobs/:id', (req, res) => {
    const index = jobs.findIndex(item => item.id === req.params.id);
    if (index < 0) return res.status(404).json({ ok: false, error: 'Job not found.' });

    const job = jobs[index];
    if (['processing', 'cancelling'].includes(job.status)) {
        return res.status(409).json({
            ok: false,
            error: 'A running job must be cancelled first.'
        });
    }

    // Queued jobs can be removed immediately.
    cleanupJobFiles(job);
    jobs.splice(index, 1);
    saveQueue();
    res.json({ ok: true });
});

// ========================================
// BULK QUEUE/HISTORY CLEANUP
// ========================================

app.delete('/api/queue/queued', (req, res) => {
    const queued = jobs.filter(item => item.status === 'queued');
    for (const job of queued) cleanupJobFiles(job);
    jobs = jobs.filter(item => item.status !== 'queued');
    saveQueue();
    res.json({ ok: true, removed: queued.length });
});

app.delete('/api/queue/history', (req, res) => {
    const history = jobs.filter(item => ['completed', 'failed', 'cancelled'].includes(item.status));
    for (const job of history) cleanupJobFiles(job);
    jobs = jobs.filter(item => !['completed', 'failed', 'cancelled'].includes(item.status));
    saveQueue();
    res.json({ ok: true, removed: history.length });
});

// ========================================
// CLOUDFLARE API
// ========================================

const CF_URL = process.env.CF_API_URL || 'https://tipiz.moviezonee.workers.dev';
const CF_KEY = process.env.CF_VPS_API_KEY;

async function cfFetch(apiPath) {
    const response = await fetch(`${CF_URL}${apiPath}`, {
        headers: { Authorization: `Bearer ${CF_KEY}` }
    });
    const body = await response.text();
    if (!response.ok) {
        throw new Error(`Cloudflare API ${response.status}: ${body.slice(0, 500)}`);
    }
    try {
        return JSON.parse(body);
    } catch (_) {
        return { raw: body };
    }
}

app.get('/api/backup', async (req, res, next) => {
    try {
        const response = await fetch(`${CF_URL}/api/vps/backup`, {
            headers: { Authorization: `Bearer ${CF_KEY}` }
        });
        if (!response.ok) throw new Error(`Backup API returned ${response.status}`);
        res.setHeader('Content-Disposition', 'attachment; filename="tipiz-backup.json"');
        res.setHeader('Content-Type', 'application/json');
        res.send(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
        next(error);
    }
});

app.get('/api/cf/videos', async (req, res, next) => {
    try { res.json(await cfFetch('/api/vps/videos')); }
    catch (error) { next(error); }
});

app.get('/api/cf/movies', async (req, res, next) => {
    try { res.json(await cfFetch('/api/admin/movies?limit=100')); }
    catch (error) { next(error); }
});

app.get('/api/cf/tv', async (req, res, next) => {
    try { res.json(await cfFetch('/api/admin/tv?limit=100')); }
    catch (error) { next(error); }
});

app.post('/api/cf/assign', async (req, res, next) => {
    try {
        const response = await fetch(`${CF_URL}/api/vps/assign`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${CF_KEY}`
            },
            body: JSON.stringify(req.body)
        });
        const body = await response.json();
        res.status(response.status).json(body);
    } catch (error) {
        next(error);
    }
});

// ========================================
// ERROR HANDLER
// ========================================

app.use((error, req, res, next) => {
    console.error(error);
    if (req.path.startsWith('/api/')) {
        return res.status(error.status || 500).json({
            ok: false,
            error: error.code === 'LIMIT_FILE_SIZE'
                ? 'Subtitle files must be 50 MB or smaller.'
                : error.code === 'LIMIT_UNEXPECTED_FILE'
                    ? 'Invalid upload field.'
                    : error.message || 'Unexpected server error.'
        });
    }
    res.status(error.status || 500).send('Unexpected server error.');
});

// ========================================
// START SERVER
// ========================================

const server = app.listen(PORT, () => {
    console.log(`TIPIZ VPS Admin listening on port ${PORT}`);
    console.log(`Automatic local AI subtitles: ${String(process.env.AI_SUBTITLES_ENABLED ?? 'true').toLowerCase() !== 'false' ? 'ON' : 'OFF'}`);
    setImmediate(runQueue);
});

function shutdown() {
    shuttingDown = true;
    for (const job of jobs.filter(item => ['processing', 'cancelling'].includes(item.status))) {
        updateJob(job.id, {
            status: 'queued',
            stage: 'Interrupted by server restart — queued again',
            progress: 0,
            error: null
        });
    }
    for (const controller of activeControllers.values()) {
        try { controller.abort(); } catch (_) {}
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
