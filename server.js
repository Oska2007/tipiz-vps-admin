require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const multer = require('multer');
const path = require('path');
const session = require('express-session');
const { processVideo } = require('./worker');

const app = express();
const PORT = process.env.PORT || 3000;
const TEMP_DIR = path.join(__dirname, 'temp');

fs.mkdirSync(TEMP_DIR, { recursive: true });

const upload = multer({
  dest: TEMP_DIR,
  limits: { fileSize: 10 * 1024 * 1024, files: 20 },
  fileFilter: (_req, file, cb) => {
    const allowed = /\.(srt|vtt)$/i.test(file.originalname);
    cb(allowed ? null : new Error('Only SRT or VTT subtitle files are allowed'), allowed);
  }
});

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(session({
  name: 'tipiz_admin',
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    maxAge: 24 * 60 * 60 * 1000
  }
}));

app.post('/login', (req, res) => {
  const username = typeof req.body.username === 'string' ? req.body.username : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';

  if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD ||
      username !== process.env.ADMIN_USERNAME || password !== process.env.ADMIN_PASSWORD) {
    return res.redirect('/login.html?error=1');
  }

  req.session.regenerate(error => {
    if (error) return res.status(500).json({ error: 'Unable to create login session' });
    req.session.isLoggedIn = true;
    req.session.save(saveError => {
      if (saveError) return res.status(500).json({ error: 'Unable to save login session' });
      res.redirect('/');
    });
  });
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login.html'));
});
app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login.html'));
});

app.use((req, res, next) => {
  if (req.path === '/login.html' || req.path === '/login' || req.path === '/logout') return next();
  if (req.session?.isLoggedIn) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/login.html');
});

app.use(express.static(path.join(__dirname, 'public')));

const jobQueue = [];
const activeJobs = new Map();
let isProcessing = false;

function cleanupFiles(files) {
  for (const file of files || []) {
    if (file?.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
  }
}

async function processQueue() {
  if (isProcessing || jobQueue.length === 0) return;
  isProcessing = true;

  const job = jobQueue.shift();
  activeJobs.set(job.id, {
    id: job.id,
    title: job.title,
    status: 'Starting...',
    progress: 0,
    error: null
  });

  const updateStatus = (status, progress) => {
    const current = activeJobs.get(job.id);
    if (current) activeJobs.set(job.id, { ...current, status, progress, error: null });
  };

  try {
    console.log(`[Queue] Starting ${job.id}: ${job.title}`);
    const result = await processVideo({ ...job, updateStatus });
    activeJobs.set(job.id, {
      id: job.id,
      title: job.title,
      status: 'Completed',
      progress: 100,
      error: null,
      result
    });
  } catch (error) {
    console.error(`[Queue] Failed ${job.id}: ${error.message}`);
    activeJobs.set(job.id, {
      id: job.id,
      title: job.title,
      status: 'Failed',
      progress: 100,
      error: error.message
    });
  } finally {
    isProcessing = false;
    setTimeout(() => activeJobs.delete(job.id), 30000);
    processQueue();
  }
}

app.post('/api/process-batch', upload.any(), (req, res) => {
  try {
    const titles = JSON.parse(req.body.titles || '[]');
    const urls = JSON.parse(req.body.urls || '[]');

    if (!Array.isArray(titles) || !Array.isArray(urls) ||
        titles.length === 0 || titles.length !== urls.length || titles.length > 10) {
      cleanupFiles(req.files);
      return res.status(400).json({ error: 'Invalid titles or URLs' });
    }

    const fileByField = new Map();
    for (const file of req.files || []) fileByField.set(file.fieldname, file);

    const jobs = [];
    for (let index = 0; index < titles.length; index++) {
      const title = titles[index]?.trim();
      const url = urls[index]?.trim();
      if (!title || !/^https?:\/\/\S+/i.test(url)) {
        cleanupFiles(req.files);
        return res.status(400).json({ error: `Invalid video at row ${index + 1}` });
      }

      const sinFile = fileByField.get(`sin_${index}`);
      const engFile = fileByField.get(`eng_${index}`);

      jobs.push({
        id: `${Date.now()}-${crypto.randomBytes(3).toString('hex')}-${index}`,
        title,
        url,
        subtitle1: sinFile?.path || null,
        subtitle1Name: sinFile?.originalname || null,
        subtitle2: engFile?.path || null,
        subtitle2Name: engFile?.originalname || null
      });
    }

    console.log(`[API] Accepted ${jobs.length} job(s), ${req.files?.length || 0} subtitle file(s)`);
    for (const job of jobs) {
      console.log(`[API] ${job.title}: Sinhala=${job.subtitle1 ? 'present' : 'missing'}, English=${job.subtitle2 ? 'present' : 'missing'}`);
      jobQueue.push(job);
    }

    processQueue();
    res.json({ ok: true, message: `${jobs.length} jobs added to queue`, jobs: jobs.map(job => ({ id: job.id, title: job.title })) });
  } catch (error) {
    cleanupFiles(req.files);
    res.status(400).json({ error: error.message || 'Invalid batch request' });
  }
});

app.get('/api/status', (_req, res) => {
  res.json(Array.from(activeJobs.values()));
});
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, queueLength: jobQueue.length, processing: isProcessing });
});

const CF_URL = (process.env.CF_API_URL || 'https://tipiz.moviezonee.workers.dev').replace(/\/$/, '');
const CF_KEY = process.env.CF_VPS_API_KEY;

async function cfFetch(relativePath) {
  const response = await fetch(`${CF_URL}${relativePath}`, {
    headers: { Authorization: `Bearer ${CF_KEY}` }
  });
  if (!response.ok) throw new Error(`Cloudflare API returned ${response.status}`);
  return response.json();
}

app.get('/api/backup', async (_req, res, next) => {
  try {
    const response = await fetch(`${CF_URL}/api/vps/backup`, {
      headers: { Authorization: `Bearer ${CF_KEY}` }
    });
    if (!response.ok) throw new Error(`Cloudflare API returned ${response.status}`);
    res.setHeader('Content-Disposition', 'attachment; filename="tipiz-backup.json"');
    res.send(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    next(error);
  }
});

app.get('/api/cf/videos', async (_req, res, next) => {
  try { res.json(await cfFetch('/api/vps/videos')); } catch (error) { next(error); }
});
app.get('/api/cf/movies', async (_req, res, next) => {
  try { res.json(await cfFetch('/api/admin/movies?limit=100')); } catch (error) { next(error); }
});
app.get('/api/cf/tv', async (_req, res, next) => {
  try { res.json(await cfFetch('/api/admin/tv?limit=100')); } catch (error) { next(error); }
});
app.post('/api/cf/assign', async (req, res, next) => {
  try {
    const response = await fetch(`${CF_URL}/api/vps/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CF_KEY}` },
      body: JSON.stringify(req.body)
    });
    if (!response.ok) throw new Error(`Cloudflare API returned ${response.status}`);
    res.json(await response.json());
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error(`[Server] ${error.message}`);
  res.status(error instanceof multer.MulterError ? 400 : 500).json({
    error: error.message || 'Internal server error'
  });
});

app.listen(PORT, () => {
  console.log(`TIPIZ VPS Admin running on http://localhost:${PORT}`);
});
