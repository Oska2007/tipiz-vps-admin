require('dotenv').config();
const express = require('express');
const path = require('path');
const session = require('express-session');
const multer = require('multer');
const fs = require('fs');
const { processVideo } = require('./worker');

const app = express();
const PORT = process.env.PORT || 3000;

// Temp folder එකක් නැත්නම් හදන්න (Multer එකට ඕන)
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

// File Upload (Subtitle) Setup
const upload = multer({ dest: 'temp/' });

// Session Setup (ලොගින් මතක තියාගන්න)
app.use(session({
  secret: process.env.SESSION_SECRET || 'tipiz-super-secret',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // පැය 24ක් වලංගු
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Login & Logout Routes ──
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
    req.session.isLoggedIn = true;
    res.redirect('/');
  } else {
    res.redirect('/login.html?error=1');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login.html');
});

// ── Auth Middleware (ආරක්ෂකයා) ──
// ලොගින් පේජ් එකයි API ටිකයි හැර අනිත් හැම පේජ් එකකටම ලොග් වෙලා ඉන්න ඕන
app.use((req, res, next) => {
  if (req.path === '/login.html' || req.path === '/login' || req.path.startsWith('/api/')) {
    return next();
  }
  if (req.session && req.session.isLoggedIn) {
    return next();
  }
  res.redirect('/login.html');
});

// ── Cloudflare API Helper ──
const CF_URL = 'https://tipiz.moviezonee.workers.dev';
const CF_KEY = process.env.CF_VPS_API_KEY;

async function cfFetch(path) {
  try {
    const res = await fetch(`${CF_URL}${path}`, { 
      headers: { 'Authorization': `Bearer ${CF_KEY}` } 
    });
    return await res.json();
  } catch (err) { 
    return { ok: false, error: err.message }; 
  }
}

// ── VPS API Routes ──

// Process Route (with File Upload)
app.post('/api/process', upload.single('subtitle'), (req, res) => {
  const { title, url } = req.body;
  if (!title || !url) return res.status(400).json({ error: 'Title and URL required' });
  
  // Subtitle file එකක් අප්ලෝඩ් වෙලා තියෙනවා නම්, ඒකේ path එක ගන්නවා
  let subtitlePath = null;
  if (req.file) {
    const ext = path.extname(req.file.originalname);
    const newPath = req.file.path + ext;
    fs.renameSync(req.file.path, newPath);
    subtitlePath = newPath;
  }

  processVideo({ title, url, subtitlePath });
  res.json({ ok: true, message: 'Processing started' });
});

// Backup Route
app.get('/api/backup', async (req, res) => {
  try {
    const response = await fetch(`${CF_URL}/api/vps/backup`, {
      headers: { 'Authorization': `Bearer ${CF_KEY}` }
    });
    if (!response.ok) throw new Error('Backup failed');
    
    const blob = await response.blob();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="tipiz-backup.json"');
    res.send(blob);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Proxy Routes (Assign Page එකට)
app.get('/api/cf/videos', async (req, res) => res.json(await cfFetch('/api/vps/videos')));
app.get('/api/cf/movies', async (req, res) => res.json(await cfFetch('/api/admin/movies?limit=100')));
app.get('/api/cf/tv', async (req, res) => res.json(await cfFetch('/api/admin/tv?limit=100')));

app.post('/api/cf/assign', async (req, res) => {
  try {
    const cfRes = await fetch(`${CF_URL}/api/vps/assign`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json', 
        'Authorization': `Bearer ${CF_KEY}` 
      },
      body: JSON.stringify(req.body)
    });
    res.json(await cfRes.json());
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`🚀 TIPIZ VPS Admin running on http://localhost:${PORT}`);
});