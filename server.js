const express = require('express');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static files (Frontend එක පෙන්නන්න)
app.use(express.static(path.join(__dirname, 'public')));

// Test API endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    ok: true, 
    message: 'TIPIZ VPS Admin is running!',
    time: new Date().toISOString()
  });
});

// Server එක පටන් ගන්න
app.listen(PORT, () => {
  console.log(`🚀 TIPIZ VPS Admin running on http://localhost:${PORT}`);
});