require('dotenv').config();
const express = require('express');
const path = require('path');
const { processVideo } = require('./worker');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API: Process Direct Link
app.post('/api/process', (req, res) => {
  const { title, url, subtitleUrl } = req.body;
  
  if (!title || !url) return res.status(400).json({ error: 'Title and URL are required' });

  const jobId = Date.now().toString();

  // Worker එකට යවනවා (පසුබිමින් වැඩේ කරගෙන යන්න)
  processVideo({ title, url, subtitleUrl });

  res.json({ ok: true, message: 'Processing started', jobId });
});

app.listen(PORT, () => {
  console.log(`🚀 TIPIZ VPS Admin running on http://localhost:${PORT}`);
});

// VPS server.js එකේ පහළට
const CF_URL = 'https://tipiz.moviezonee.workers.dev';
const CF_KEY = process.env.CF_VPS_API_KEY;

// Helper to call CF API
async function cfFetch(path) {
  const res = await fetch(`${CF_URL}${path}`, {
    headers: { 'Authorization': `Bearer ${CF_KEY}` }
  });
  return res.json();
}

// VPS API Endpoints
app.get('/api/cf/videos', async (req, res) => {
  const data = await cfFetch('/api/vps/videos');
  res.json(data);
});

app.get('/api/cf/movies', async (req, res) => {
  const data = await cfFetch('/api/admin/movies?limit=100');
  res.json(data);
});

app.get('/api/cf/tv', async (req, res) => {
  const data = await cfFetch('/api/admin/tv?limit=100');
  res.json(data);
});

app.post('/api/cf/assign', async (req, res) => {
  const cfRes = await fetch(`${CF_URL}/api/vps/assign`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CF_KEY}`
    },
    body: JSON.stringify(req.body)
  });
  const data = await cfRes.json();
  res.json(data);
});