const express = require('express');
const path = require('path');
const dataHandler = require('./api/data');
const leadsHandler = require('./api/leads');
const updateHandler = require('./api/update');

const app = express();
const PORT = 3456;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Wrap the Vercel serverless handlers for Express
app.get('/api/data', (req, res) => dataHandler(req, res));
app.get('/api/refresh', (req, res) => {
  req.url += (req.url.includes('?') ? '&' : '?') + 'refresh=true';
  dataHandler(req, res);
});
app.get('/api/leads', (req, res) => leadsHandler(req, res));
app.post('/api/update', (req, res) => updateHandler(req, res));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`IIP Dashboard running at http://localhost:${PORT}`);
});
