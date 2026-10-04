// server.js — jalankan di VPS/hosting Node (BUKAN Vercel). Butuh: npm i
const express = require('express');
const crypto = require('crypto');
const { installPanel, validate } = require('./installpanel');

const TOKEN = process.env.API_TOKEN;
const ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const PORT = process.env.PORT || 1026;
const MAX_JOBS = 2;
if (!TOKEN) { console.error('Set dulu: API_TOKEN=rahasiamu node server.js'); process.exit(1); }

const app = express();
app.use(express.json({ limit: '10kb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
const auth = (req, res, next) => {
  const a = Buffer.from(String(req.headers['x-token'] || req.query.token || '')), b = Buffer.from(TOKEN);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ success: false, message: 'Token salah' });
  next();
};

const jobs = new Map();
const send = (job, ev, data) => job.clients.forEach(r => r.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`));
const closeAll = (job) => { job.clients.forEach(r => r.end()); job.clients = []; };

app.post('/api/install', auth, (req, res) => {
  const p = req.body || {};
  const err = validate(p);
  if (err) return res.status(400).json({ success: false, message: err });
  if ([...jobs.values()].filter(j => j.status === 'running').length >= MAX_JOBS)
    return res.status(429).json({ success: false, message: 'Server sibuk, coba lagi nanti' });

  const id = crypto.randomBytes(8).toString('hex');
  const job = { status: 'running', logs: [], clients: [], result: null, error: null };
  jobs.set(id, job);
  res.json({ success: true, id });

  installPanel(p, (type, message) => { job.logs.push({ type, message }); send(job, 'log', { type, message }); })
    .then(r => { job.status = 'done'; job.result = r; send(job, 'done', r); closeAll(job); })
    .catch(e => { job.status = 'fail'; job.error = e.message; send(job, 'fail', { message: e.message }); closeAll(job); })
    .finally(() => setTimeout(() => jobs.delete(id), 900e3));
});

app.get('/api/stream/:id', auth, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ success: false, message: 'Instalasi tidak ditemukan' });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  job.logs.forEach(l => res.write(`event: log\ndata: ${JSON.stringify(l)}\n\n`));
  if (job.status === 'done') { res.write(`event: done\ndata: ${JSON.stringify(job.result)}\n\n`); return res.end(); }
  if (job.status === 'fail') { res.write(`event: fail\ndata: ${JSON.stringify({ message: job.error })}\n\n`); return res.end(); }
  job.clients.push(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { clearInterval(ping); job.clients = job.clients.filter(c => c !== res); });
});

app.listen(PORT, () => console.log(`Installer API jalan di port ${PORT}`));
