const express = require('express');
const path = require('path');
const { processVideo } = require('./worker'); // අලුත් worker එක import කරගන්නවා
require('dotenv').config();

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