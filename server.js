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

const upload = multer({ dest: 'temp/' });

app.use(session({
  secret: process.env.SESSION_SECRET || 'tipiz-secret',
  resave: false, saveUninitialized: true,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Login
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
    req.session.isLoggedIn = true; res.redirect('/');
  } else res.redirect('/login.html?error=1');
});
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login.html'); });
app.use((req, res, next) => {
  if (req.path === '/login.html' || req.path === '/login' || req.path.startsWith('/api/')) return next();
  if (req.session && req.session.isLoggedIn) return next();
  res.redirect('/login.html');
});

// ── JOB QUEUE SYSTEM ──
let jobQueue = []; // පේළියේ ඉන්න ජොබ්ස්
let activeJobs = {}; // ධාවනය වෙන ජොබ්ස් (UI එකට යවන්න)
let isProcessing = false;

async function processQueue() {
  if (isProcessing || jobQueue.length === 0) return;
  isProcessing = true;

  const job = jobQueue.shift(); // පළවෙනි එක ගන්නවා
  const jobId = job.id;
  activeJobs[jobId] = { title: job.title, status: 'Starting...', progress: 0, error: null };

  const updateStatus = (status, progress, isError = false) => {
    activeJobs[jobId] = { title: job.title, status: status, progress: progress, error: isError ? status : null };
  };

  await processVideo({ ...job, updateStatus });

  // ජොබ් එක ඉවර වුණාම, ටික වෙලාවකින් ලිස්ට් එකෙන් අයින් කරන්න
  setTimeout(() => { delete activeJobs[jobId]; }, 10000); 

  isProcessing = false;
  processQueue(); // ඊළඟ එක පටන් ගන්නවා
}

// API: Batch Process
app.post('/api/process-batch', upload.fields([{ name: 'subtitle1', maxCount: 1 }, { name: 'subtitle2', maxCount: 1 }]), (req, res) => {
  const titles = JSON.parse(req.body.titles);
  const urls = JSON.parse(req.body.urls);

  if (titles.length > 10) return res.status(400).json({ error: 'Max 10 links allowed' });

  const sub1Path = req.files['subtitle1'] ? req.files['subtitle1'][0].path : null;
  const sub2Path = req.files['subtitle2'] ? req.files['subtitle2'][0].path : null;

  for (let i = 0; i < titles.length; i++) {
    jobQueue.push({
      id: Date.now() + i,
      title: titles[i],
      url: urls[i],
      subtitle1: sub1Path, // සියලුම වීඩියෝ වලට එකම සබ්ටයිටල් දෙක දානවා
      subtitle2: sub2Path
    });
  }

  processQueue(); // පටන් ගන්නවා
  res.json({ ok: true, message: 'Jobs added to queue' });
});

// API: Get Status (Live Polling)
app.get('/api/status', (req, res) => {
  res.json(Object.values(activeJobs));
});

// ── Cloudflare Proxy Routes (Assign/Backup) ──
const CF_URL = 'https://tipiz.moviezonee.workers.dev';
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

app.listen(PORT, () => console.log(`🚀 TIPIZ VPS Admin running on http://localhost:${PORT}`));