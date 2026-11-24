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

for (const dir of [DATA_DIR, TEMP_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
}

function loadQueue() {
    try {
        const data = JSON.parse(
            fs.readFileSync(QUEUE_FILE, 'utf8')
        );

        return Array.isArray(data) ? data : [];

    } catch (e) {
        if (e.code !== 'ENOENT') {
            console.error('Queue file error:', e.message);
        }

        return [];
    }
}

let jobs = loadQueue();

for (const job of jobs) {
    if (job.status === 'processing') {
        job.status = 'queued';
        job.stage = 'Waiting after server restart';
        job.progress = 0;
        job.updatedAt = new Date().toISOString();
    }
}

function saveQueue() {
    const temp = `${QUEUE_FILE}.tmp`;

    fs.writeFileSync(
        temp,
        JSON.stringify(jobs, null, 2)
    );

    fs.renameSync(temp, QUEUE_FILE);
}

saveQueue();

const upload = multer({
    storage: multer.diskStorage({

        destination: TEMP_DIR,

        filename: (req, file, cb) => {
            const ext = path.extname(
                file.originalname
            ).toLowerCase();

            if (!['.srt', '.vtt'].includes(ext)) {
                return cb(
                    Object.assign(
                        new Error(
                            'Subtitle files must be .srt or .vtt.'
                        ),
                        { status: 400 }
                    )
                );
            }

            cb(null, `${randomUUID()}${ext}`);
        }

    }),

    limits: {
        files: 20,
        fields: 30
    }
});

if (!process.env.SESSION_SECRET) {
    console.error('SESSION_SECRET is missing from .env.');
    process.exit(1);
}

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

        return req.session.save(() => {
            res.redirect('/');
        });
    }

    res.redirect('/login.html?error=1');
});

// LOGOUT

app.get('/logout', (req, res) => {

    req.session.destroy(() => {
        res.redirect('/login.html');
    });

});

// AUTHENTICATION

app.use((req, res, next) => {

    if (
        req.path === '/login.html' ||
        req.path === '/login'
    ) {
        return next();
    }

    if (req.session?.isLoggedIn) {
        return next();
    }

    if (req.path.startsWith('/api/')) {
        return res.status(401).json({
            ok: false,
            error: 'Session expired. Please log in again.'
        });
    }

    return res.redirect('/login.html');

});

app.use(express.static(
    path.join(__dirname, 'public')
));

// ========================================
// PERSISTENT QUEUE
// ========================================

let workerRunning = false;

const MAX_HISTORY = 100;

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

    const job = jobs.find(
        j => j.id === id
    );

    if (!job) return;

    Object.assign(job, patch, {
        updatedAt: new Date().toISOString()
    });

    saveQueue();

}

// ========================================
// QUEUE PROCESSOR
// ========================================

async function runQueue() {

    if (workerRunning) return;

    workerRunning = true;

    try {

        while (true) {

            const job = jobs.find(
                j => j.status === 'queued'
            );

            if (!job) break;

            updateJob(job.id, {
                status: 'processing',
                stage: 'Starting',
                progress: 0,
                error: null,
                startedAt: new Date().toISOString()
            });

            let lastWriteAt = 0;
            let lastStage = '';

            const report = (
                stage,
                progress,
                extra = {}
            ) => {

                const now = Date.now();

                const rounded = Number.isFinite(progress)
                    ? Math.max(
                        0,
                        Math.min(99, Math.round(progress))
                    )
                    : null;

                if (
                    stage === lastStage &&
                    now - lastWriteAt < 1000 &&
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

            try {

                await processVideo({
                    ...job,
                    updateStatus: report
                });

                updateJob(job.id, {
                    status: 'completed',
                    stage: 'Completed',
                    progress: 100,
                    completedAt: new Date().toISOString(),
                    error: null
                });

            } catch (err) {

                console.error(
                    `Job ${job.id} failed:`,
                    err
                );

                updateJob(job.id, {
                    status: 'failed',
                    stage: 'Failed',
                    progress: null,
                    error: String(
                        err.message || err
                    ).slice(0, 1500),
                    failedAt: new Date().toISOString()
                });

            }

            const finished = jobs.filter(j =>
                ['completed', 'failed'].includes(j.status)
            );

            if (finished.length > MAX_HISTORY) {

                const removeIds = new Set(
                    finished
                        .slice(
                            0,
                            finished.length - MAX_HISTORY
                        )
                        .map(j => j.id)
                );

                jobs = jobs.filter(
                    j => !removeIds.has(j.id)
                );

                saveQueue();

            }

        }

    } finally {

        workerRunning = false;

        if (jobs.some(j => j.status === 'queued')) {
            setImmediate(runQueue);
        }

    }

}

// ========================================
// ADD VIDEO BATCH
// ========================================

app.post(
    '/api/process-batch',
    upload.any(),
    (req, res) => {

        let titles;
        let urls;

        try {

            titles = JSON.parse(req.body.titles);
            urls = JSON.parse(req.body.urls);

        } catch {

            return res.status(400).json({
                ok: false,
                error: 'Invalid batch data.'
            });

        }

        if (
            !Array.isArray(titles) ||
            !Array.isArray(urls) ||
            titles.length < 1 ||
            titles.length > 10 ||
            titles.length !== urls.length
        ) {

            return res.status(400).json({
                ok: false,
                error: 'A batch must contain 1-10 matching titles and URLs.'
            });

        }

        for (let i = 0; i < titles.length; i++) {

            if (
                typeof titles[i] !== 'string' ||
                !titles[i].trim() ||
                titles[i].length > 300 ||
                typeof urls[i] !== 'string' ||
                !/^https?:\/\//i.test(urls[i])
            ) {

                return res.status(400).json({
                    ok: false,
                    error: 'Every job needs a title and valid HTTP/HTTPS URL.'
                });

            }

        }

        const filesMap = {};

        for (const file of (req.files || [])) {
            filesMap[file.fieldname] = file.path;
        }

        const added = [];

        for (let i = 0; i < titles.length; i++) {

            const job = {

                id: randomUUID(),

                title: titles[i].trim(),

                url: urls[i],

                subtitle1: filesMap[`sub1_${i}`] || null,

                subtitle2: filesMap[`sub2_${i}`] || null,

                status: 'queued',

                stage: 'Waiting in queue',

                progress: 0,

                createdAt: new Date().toISOString(),

                updatedAt: new Date().toISOString(),

                error: null

            };

            jobs.push(job);

            added.push(job.id);

        }

        saveQueue();

        res.json({
            ok: true,
            message: `${added.length} job(s) added to queue.`,
            ids: added
        });

        setImmediate(runQueue);

    }
);

// ========================================
// QUEUE STATUS
// ========================================

app.get('/api/status', (req, res) => {

    res.set('Cache-Control', 'no-store');

    res.json(
        jobs.map(publicJob)
    );

});

// ========================================
// RETRY FAILED JOB
// ========================================

app.post('/api/jobs/:id/retry', (req, res) => {

    const job = jobs.find(
        j => j.id === req.params.id
    );

    if (!job) {
        return res.status(404).json({
            ok: false,
            error: 'Job not found.'
        });
    }

    if (job.status !== 'failed') {
        return res.status(409).json({
            ok: false,
            error: 'Only failed jobs can be retried.'
        });
    }

    if (
        (job.subtitle1 && !fs.existsSync(job.subtitle1)) ||
        (job.subtitle2 && !fs.existsSync(job.subtitle2))
    ) {
        return res.status(409).json({
            ok: false,
            error: 'Subtitle temp file is missing. Please submit this video again with subtitles.'
        });
    }

    updateJob(job.id, {

        status: 'queued',

        stage: 'Waiting for retry',

        progress: 0,

        error: null,

        startedAt: null,

        failedAt: null

    });

    setImmediate(runQueue);

    res.json({ ok: true });

});

// ========================================
// DELETE HISTORY JOB
// ========================================

app.delete('/api/jobs/:id', (req, res) => {

    const index = jobs.findIndex(
        j => j.id === req.params.id
    );

    if (index < 0) {
        return res.status(404).json({
            ok: false,
            error: 'Job not found.'
        });
    }

    if (
        jobs[index].status === 'processing' ||
        jobs[index].status === 'queued'
    ) {
        return res.status(409).json({
            ok: false,
            error: 'Cannot delete a queued or processing job.'
        });
    }

    const removed = jobs.splice(index, 1)[0];

    for (const file of [
        removed.subtitle1,
        removed.subtitle2
    ]) {

        if (file && fs.existsSync(file)) {

            try {
                fs.unlinkSync(file);
            } catch (_) {}

        }

    }

    saveQueue();

    res.json({ ok: true });

});

// ========================================
// CLOUDFLARE API
// ========================================

const CF_URL =
    process.env.CF_API_URL ||
    'https://tipiz.moviezonee.workers.dev';

const CF_KEY = process.env.CF_VPS_API_KEY;

async function cfFetch(apiPath) {

    const r = await fetch(
        `${CF_URL}${apiPath}`,
        {
            headers: {
                Authorization: `Bearer ${CF_KEY}`
            }
        }
    );

    const body = await r.text();

    if (!r.ok) {
        throw new Error(
            `Cloudflare API ${r.status}: ${body.slice(0, 500)}`
        );
    }

    try {
        return JSON.parse(body);
    } catch {
        return { raw: body };
    }

}

// BACKUP

app.get('/api/backup', async (req, res, next) => {

    try {

        const r = await fetch(
            `${CF_URL}/api/vps/backup`,
            {
                headers: {
                    Authorization: `Bearer ${CF_KEY}`
                }
            }
        );

        if (!r.ok) {
            throw new Error(
                `Backup API returned ${r.status}`
            );
        }

        res.setHeader(
            'Content-Disposition',
            'attachment; filename="tipiz-backup.json"'
        );

        res.setHeader(
            'Content-Type',
            'application/json'
        );

        res.send(
            Buffer.from(await r.arrayBuffer())
        );

    } catch (e) {
        next(e);
    }

});

// VIDEOS

app.get('/api/cf/videos', async (req, res, next) => {

    try {
        res.json(
            await cfFetch('/api/vps/videos')
        );
    } catch (e) {
        next(e);
    }

});

// MOVIES

app.get('/api/cf/movies', async (req, res, next) => {

    try {
        res.json(
            await cfFetch('/api/admin/movies?limit=100')
        );
    } catch (e) {
        next(e);
    }

});

// TV

app.get('/api/cf/tv', async (req, res, next) => {

    try {
        res.json(
            await cfFetch('/api/admin/tv?limit=100')
        );
    } catch (e) {
        next(e);
    }

});

// ASSIGN

app.post('/api/cf/assign', async (req, res, next) => {

    try {

        const r = await fetch(
            `${CF_URL}/api/vps/assign`,
            {
                method: 'POST',

                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${CF_KEY}`
                },

                body: JSON.stringify(req.body)
            }
        );

        const body = await r.json();

        res.status(r.status).json(body);

    } catch (e) {
        next(e);
    }

});

// ========================================
// ERROR HANDLER
// ========================================

app.use((err, req, res, next) => {

    console.error(err);

    if (req.path.startsWith('/api/')) {

        return res.status(err.status || 500).json({

            ok: false,

            error:
                err.code === 'LIMIT_UNEXPECTED_FILE'
                    ? 'Invalid upload field.'
                    : err.message || 'Unexpected server error.'

        });

    }

    res.status(err.status || 500).send(
        'Unexpected server error.'
    );

});

// ========================================
// START SERVER
// ========================================

const server = app.listen(PORT, () => {

    console.log(
        `TIPIZ VPS Admin listening on port ${PORT}`
    );

    setImmediate(runQueue);

});

// GRACEFUL SHUTDOWN

function shutdown() {

    server.close(() => process.exit(0));

    setTimeout(
        () => process.exit(1),
        10000
    ).unref();

}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);