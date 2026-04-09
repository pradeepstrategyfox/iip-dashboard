const express = require('express');
const path = require('path');
const apiHandler = require('./api/data');

const app = express();
const PORT = 3456;

app.use(express.static(path.join(__dirname, 'public')));

// Wrap the Vercel serverless handler for Express
app.get('/api/data', (req, res) => {
  apiHandler(req, res);
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`IIP Dashboard running at http://localhost:${PORT}`);
});
