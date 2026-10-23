const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const tls = require('tls');
const root = path.resolve(__dirname, '..', 'outputs');
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };
const GEMINI_MODELS = ['gemini-3.1-flash-lite', 'gemini-flash-lite-latest'];
const GEMINI_RETRY_DELAYS = [0, 800, 1800];

const databaseFile = path.join(__dirname, 'quizzly-database.json');

function getShareBaseUrl() {
  if (process.env.QUIZ_SHARE_BASE_URL) return process.env.QUIZ_SHARE_BASE_URL.replace(/\/$/, '');
  const interfaces = os.networkInterfaces();
  const candidates = Object.entries(interfaces).flatMap(([name, addresses]) => (addresses || [])
    .filter(address => address.family === 'IPv4' && !address.internal)
    .map(address => ({ name, address: address.address })));
  const preferred = candidates.find(item => /wi-?fi|wireless|ethernet/i.test(item.name)) || candidates[0];
  return preferred ? `http://${preferred.address}:4174` : 'http://127.0.0.1:4174';
}

function loadLocalEnv() {
  const envFile = path.join(__dirname, '.env');
  try {
    fs.readFileSync(envFile, 'utf8').split(/\r?\n/).forEach(line => {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    });
  } catch {
    // Email configuration is optional until the user adds work/.env.
  }
}

loadLocalEnv();
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

function loadDatabase() {
  try {
    const data = JSON.parse(fs.readFileSync(databaseFile, 'utf8'));
    return {
      quizzes: Array.isArray(data.quizzes) ? data.quizzes : [],
      results: Array.isArray(data.results) ? data.results : [],
    };
  } catch {
    return { quizzes: [], results: [] };
  }
}

function saveDatabase(database) {
  fs.writeFileSync(databaseFile, JSON.stringify(database, null, 2));
}

function smtpResponse(socket) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const finish = () => {
      const lines = buffer.trim().split(/\r?\n/);
      const last = lines[lines.length - 1] || '';
      if (/^\d{3} /.test(last)) {
        cleanup();
        resolve(buffer);
      }
    };
    const onData = chunk => { buffer += chunk.toString(); finish(); };
    const onError = error => { cleanup(); reject(error); };
    const onClose = () => { cleanup(); reject(new Error('SMTP connection closed unexpectedly')); };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

async function smtpCommand(socket, command, expectedCode) {
  socket.write(`${command}\r\n`);
  const response = await smtpResponse(socket);
  if (!response.startsWith(expectedCode)) throw new Error(`SMTP error: ${response.trim()}`);
  return response;
}

async function sendViaGmail({ to, subject, text, html }) {
  const user = process.env.GMAIL_USER;
  const password = String(process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
  if (!user || !password) throw new Error('Gmail SMTP is not configured');
  const socket = await new Promise((resolve, reject) => {
    const connection = tls.connect({ host: 'smtp.gmail.com', port: 465, servername: 'smtp.gmail.com' }, () => resolve(connection));
    connection.once('error', reject);
  });
  try {
    await smtpResponse(socket);
    await smtpCommand(socket, 'EHLO quizzly.local', '250');
    await smtpCommand(socket, 'AUTH LOGIN', '334');
    await smtpCommand(socket, Buffer.from(user).toString('base64'), '334');
    await smtpCommand(socket, Buffer.from(password).toString('base64'), '235');
    await smtpCommand(socket, `MAIL FROM:<${user}>`, '250');
    await smtpCommand(socket, `RCPT TO:<${to}>`, '250');
    await smtpCommand(socket, 'DATA', '354');
    const safeHtml = String(html || '').replace(/^\./gm, '..');
    const message = `From: ${user}\r\nTo: ${to}\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary="quizzly-boundary"\r\n\r\n--quizzly-boundary\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n\r\n--quizzly-boundary\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${safeHtml}\r\n\r\n--quizzly-boundary--\r\n.`;
    await smtpCommand(socket, message, '250');
    await smtpCommand(socket, 'QUIT', '221');
  } finally {
    socket.end();
  }
}

async function sendViaResend({ to, subject, text, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) throw new Error('Resend email is not configured');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, text, html }),
  });
  if (!response.ok) throw new Error(`Email provider returned ${response.status}`);
}

async function sendEmail(message) {
  if (process.env.RESEND_API_KEY) return sendViaResend(message);
  return sendViaGmail(message);
}

async function handleEmail(req, res, pathname) {
  if (req.method !== 'POST' || !['/api/send-email', '/api/send-result'].includes(pathname)) return false;
  try {
    const body = await readBody(req);
    const result = body.result;
    const to = body.to || result?.studentEmail;
    if (!to) {
      sendJson(res, 400, { error: { message: 'Recipient email is required' } });
      return true;
    }
    const subject = body.subject || `Quiz result: ${result?.quizTitle || 'Quizzly'}`;
    const text = body.text || `Your result for ${result?.quizTitle || 'your quiz'}: ${result?.score ?? ''}% (${result?.correct ?? ''}/${result?.total ?? ''})`;
    const html = body.html || `<p>${text.replace(/\n/g, '<br>')}</p>`;
    await sendEmail({ to, subject, text, html });
    sendJson(res, 200, { sent: true });
  } catch (error) {
    sendJson(res, 503, { error: { message: error.message || 'Email could not be sent' } });
  }
  return true;
}

async function handleDatabase(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/state') {
    sendJson(res, 200, { ...loadDatabase(), shareBaseUrl: getShareBaseUrl() });
    return true;
  }

  if (req.method === 'GET' && pathname.startsWith('/api/quizzes/')) {
    const id = decodeURIComponent(pathname.slice('/api/quizzes/'.length));
    const quiz = loadDatabase().quizzes.find(item => item.id === id);
    if (!quiz) {
      sendJson(res, 404, { error: { message: 'Quiz not found' } });
      return true;
    }
    sendJson(res, 200, { quiz });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/quizzes') {
    try {
      const body = await readBody(req);
      const quiz = body.quiz;
      if (!quiz?.id || !Array.isArray(quiz.questions)) {
        sendJson(res, 400, { error: { message: 'A quiz with an id and questions is required' } });
        return true;
      }
      const database = loadDatabase();
      database.quizzes = [quiz, ...database.quizzes.filter(item => item.id !== quiz.id)];
      saveDatabase(database);
      sendJson(res, 200, { quiz });
    } catch (error) {
      sendJson(res, 400, { error: { message: error.message || 'Quiz could not be saved' } });
    }
    return true;
  }

  if (req.method === 'DELETE' && pathname.startsWith('/api/quizzes/')) {
    const id = decodeURIComponent(pathname.slice('/api/quizzes/'.length));
    const database = loadDatabase();
    database.quizzes = database.quizzes.filter(item => item.id !== id);
    saveDatabase(database);
    sendJson(res, 200, { deleted: id });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/results') {
    try {
      const body = await readBody(req);
      const result = body.result;
      if (!result?.id || !result.quizId) {
        sendJson(res, 400, { error: { message: 'A result with an id and quiz id is required' } });
        return true;
      }
      const database = loadDatabase();
      database.results = [result, ...database.results.filter(item => item.id !== result.id)];
      saveDatabase(database);
      sendJson(res, 200, { result });
    } catch (error) {
      sendJson(res, 400, { error: { message: error.message || 'Result could not be saved' } });
    }
    return true;
  }

  return false;
}

async function handleGemini(req, res) {
  try {
    const body = await readBody(req);
    if (!GEMINI_API_KEY) {
      sendJson(res, 503, { error: { message: 'GEMINI_API_KEY is not configured' } });
      return;
    }
    if (!body.prompt || !body.schema) {
      sendJson(res, 400, { error: { message: 'Missing Gemini prompt or schema' } });
      return;
    }
    const request = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: body.prompt }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: body.schema, temperature: body.temperature ?? 0.85 },
      }),
    };
    let lastResponse;
    let lastPayload = '';
    for (const model of GEMINI_MODELS) {
      for (const delay of GEMINI_RETRY_DELAYS) {
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, request);
        const payload = await response.text();
        lastResponse = response;
        lastPayload = payload;
        console.log(`Gemini ${model} status:`, response.status);
        if (response.ok || ![429, 500, 503].includes(response.status)) break;
      }
      if (lastResponse.ok || ![429, 500, 503].includes(lastResponse.status)) break;
    }
    res.writeHead(lastResponse.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(lastPayload);
  } catch (error) {
    sendJson(res, 500, { error: { message: error.message || 'Gemini proxy failed' } });
  }
}

http.createServer(async (req, res) => {
  const pathname = req.url.split('?')[0];
  if (await handleDatabase(req, res, pathname)) return;
  if (await handleEmail(req, res, pathname)) return;
  if (req.method === 'POST' && pathname === '/api/generate') {
    await handleGemini(req, res);
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    res.end('Method not allowed');
    return;
  }
  const requestPath = pathname === '/' || pathname.startsWith('/quiz/') ? '/index.html' : pathname;
  const file = path.join(root, requestPath);
  if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}).listen(4174, '0.0.0.0', () => console.log(`clean preview server listening on ${getShareBaseUrl()}`));
