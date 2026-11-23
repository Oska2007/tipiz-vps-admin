require('dotenv').config();
const express = require('express');
const path = require('path');
const session = require('express-session');
const multer = require('multer');
const fs = require('fs');
const { processVideo } = require('./worker');

const app = express();
const PORT = process.env.PORT || 3000;

const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

// Multer setup (Dynamic fields)
const upload = multer({ dest: 'temp/' });

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false, saveUninitialized: true,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Login
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD &&
      username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
    req.session.isLoggedIn = true; res.redirect('/');
  } else res.redirect('/login.html?error=1');
});
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login.html'); });
app.use((req, res, next) => {
  if (req.path === '/login.html' || req.path === '/login') return next();
  if (req.session && req.session.isLoggedIn) return next();
  res.redirect('/login.html');
});

// ── JOB QUEUE SYSTEM ──
let jobQueue = []; 
let activeJobs = {}; 
let isProcessing = false;

async function processQueue() {
  if (isProcessing || jobQueue.length === 0) return;
  isProcessing = true;

  const job = jobQueue.shift(); 
  const jobId = job.id;
  activeJobs[jobId] = { title: job.title, status: 'Starting...', progress: 0 };

  const updateStatus = (status, progress) => {
    activeJobs[jobId] = { title: job.title, status: status, progress: progress };
  };

  await processVideo({ ...job, updateStatus }).catch((err) => {
    updateStatus('Failed: ' + err.message, 100);
    console.error(`❌ Job ${jobId} failed:`, err);
  });

  setTimeout(() => { delete activeJobs[jobId]; }, 10000); 
  isProcessing = false;
  processQueue(); 
}

// API: Batch Process (Accepts dynamic files)
app.post('/api/process-batch', upload.any(), (req, res) => {
  let titles;
  let urls;
  try {
    titles = JSON.parse(req.body.titles);
    urls = JSON.parse(req.body.urls);
  } catch {
    return res.status(400).json({ ok: false, error: 'Invalid batch data.' });
  }

  if (!Array.isArray(titles) || !Array.isArray(urls) ||
      titles.length === 0 || titles.length !== urls.length || titles.length > 10) {
    return res.status(400).json({ ok: false, error: 'A batch must contain 1-10 matching titles and URLs.' });
  }

  for (let i = 0; i < titles.length; i++) {
    if (typeof titles[i] !== 'string' || !titles[i].trim() ||
        typeof urls[i] !== 'string' || !/^https?:\/\//i.test(urls[i])) {
      return res.status(400).json({ ok: false, error: 'Every job requires a title and valid HTTP URL.' });
    }
  }

  // Map files to their respective index (e.g., sub1_0, sub2_0)
  const filesMap = {};
  if (req.files) {
    req.files.forEach(file => {
      filesMap[file.fieldname] = file.path;
    });
  }

  for (let i = 0; i < titles.length; i++) {
    jobQueue.push({
      id: Date.now() + i,
      title: titles[i],
      url: urls[i],
      subtitle1: filesMap[`sub1_${i}`] || null,
      subtitle2: filesMap[`sub2_${i}`] || null
    });
  }

  processQueue(); 
  res.json({ ok: true, message: `${titles.length} jobs added to queue` });
});

// API: Get Status
app.get('/api/status', (req, res) => {
  res.json(Object.values(activeJobs));
});

// ── Cloudflare Proxy Routes ──
const CF_URL = process.env.CF_API_URL || 'https://tipiz.moviezonee.workers.dev';
const CF_KEY = process.env.CF_VPS_API_KEY;

async function cfFetch(path) {
  const res = await fetch(`${CF_URL}${path}`, { headers: { 'Authorization': `Bearer ${CF_KEY}` } });
  return await res.json();
}

app.get('/api/backup', async (req, res) => {
  const response = await fetch(`${CF_URL}/api/vps/backup`, { headers: { 'Authorization': `Bearer ${CF_KEY}` } });
  const blob = await response.blob();
  res.setHeader('Content-Disposition', 'attachment; filename="tipiz-backup.json"');
  res.send(blob);
});

app.get('/api/cf/videos', async (req, res) => res.json(await cfFetch('/api/vps/videos')));
app.get('/api/cf/movies', async (req, res) => res.json(await cfFetch('/api/admin/movies?limit=100')));
app.get('/api/cf/tv', async (req, res) => res.json(await cfFetch('/api/admin/tv?limit=100')));

app.post('/api/cf/assign', async (req, res) => {
  const cfRes = await fetch(`${CF_URL}/api/vps/assign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CF_KEY}` },
    body: JSON.stringify(req.body)
  });
  res.json(await cfRes.json());
});

app.use((err, req, res, next) => {
  console.error(err);

  if (req.path.startsWith('/api/')) {
    const message = err.code === 'LIMIT_UNEXPECTED_FILE'
      ? 'Invalid upload field.'
      : err.message || 'Unexpected server error.';
    return res.status(err.status || 500).json({ ok: false, error: message });
  }

  res.status(err.status || 500).send('Unexpected server error');
});

app.listen(PORT, () => console.log(`🚀 TIPIZ VPS Admin running on http://localhost:${PORT}`));