// Servidor simples (sem framework) para o Controle de Coletas.
// Serve os arquivos estaticos da pasta /public, protege o app com
// login de usuario/senha fixos (via variavel de ambiente) e uma API
// minima que le/grava o estado (veiculos, coletas, config) no Supabase.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TABLE = 'estado_frota';
const ROW_ID = 'frota';
const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'nc-anexos';

const LOGIN_USER = process.env.LOGIN_USER || 'admin';
const LOGIN_PASS = process.env.LOGIN_PASS || 'admin';
const SESSION_SECRET = process.env.SESSION_SECRET || 'troque-este-segredo-em-producao';
const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 dias, em segundos

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.warn('Aviso: SUPABASE_URL / SUPABASE_SERVICE_KEY nao configuradas. A API /api/estado vai falhar ate configurar essas variaveis de ambiente.');
}
if (!process.env.LOGIN_USER || !process.env.LOGIN_PASS) {
  console.warn('Aviso: LOGIN_USER / LOGIN_PASS nao configuradas. Usando usuario/senha padrao (admin/admin) - troque isso em producao.');
}

// ---------- sessao (cookie assinado, sem guardar nada no servidor) ----------

function assinar(valor) {
  const hmac = crypto.createHmac('sha256', SESSION_SECRET).update(valor).digest('hex');
  return `${valor}.${hmac}`;
}

function sessaoValida(cookieValue) {
  if (!cookieValue) return false;
  const idx = cookieValue.lastIndexOf('.');
  if (idx === -1) return false;
  const valor = cookieValue.slice(0, idx);
  const assinatura = cookieValue.slice(idx + 1);
  const esperado = crypto.createHmac('sha256', SESSION_SECRET).update(valor).digest('hex');
  const a = Buffer.from(assinatura);
  const b = Buffer.from(esperado);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const [usuario, expiraStr] = valor.split('|');
  const expira = Number(expiraStr);
  if (!expira || Date.now() > expira) return false;
  return true;
}

function lerCookies(req) {
  const header = req.headers.cookie || '';
  const cookies = {};
  header.split(';').forEach(par => {
    const idx = par.indexOf('=');
    if (idx === -1) return;
    const k = par.slice(0, idx).trim();
    const v = par.slice(idx + 1).trim();
    if (k) cookies[k] = decodeURIComponent(v);
  });
  return cookies;
}

function estaAutenticado(req) {
  const cookies = lerCookies(req);
  return sessaoValida(cookies.sessao);
}

function criarCookieSessao(usuario) {
  const expira = Date.now() + SESSION_MAX_AGE * 1000;
  const valor = `${usuario}|${expira}`;
  const assinado = assinar(valor);
  return `sessao=${encodeURIComponent(assinado)}; HttpOnly; Path=/; Max-Age=${SESSION_MAX_AGE}; SameSite=Lax`;
}

function cookieLogout() {
  return 'sessao=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax';
}

// ---------- utilitarios http ----------

function sendJSON(res, status, body, extraHeaders) {
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, extraHeaders || {}));
  res.end(JSON.stringify(body));
}

function serveFile(res, filePath) {
  const ext = path.extname(filePath);
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/manifest+json',
    '.png': 'image/png',
    '.ico': 'image/x-icon'
  };
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Nao encontrado'); return; }
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function lerCorpoJSON(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// ---------- Supabase ----------

async function getEstado() {
  const url = `${SUPABASE_URL}/rest/v1/${TABLE}?id=eq.${ROW_ID}&select=data`;
  const r = await fetch(url, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  });
  if (!r.ok) throw new Error(`Supabase GET falhou: ${r.status}`);
  const rows = await r.json();
  return rows[0] ? rows[0].data : null;
}

async function saveEstado(data) {
  const url = `${SUPABASE_URL}/rest/v1/${TABLE}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates'
    },
    body: JSON.stringify({ id: ROW_ID, data, updated_at: new Date().toISOString() })
  });
  if (!r.ok) throw new Error(`Supabase POST falhou: ${r.status}`);
}

// ---------- Supabase Storage (anexos: fotos, videos, PDFs) ----------
// Guardar esses arquivos aqui (em vez de embutidos como base64 dentro do
// JSON do estado) e' o que faz o app carregar rapido: o /api/estado passa
// a trafegar so texto leve (nomes e links), e cada arquivo e' baixado pelo
// navegador somente quando de fato exibido.

let bucketVerificado = false;

async function garantirBucket() {
  if (bucketVerificado) return;
  try {
    await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ id: STORAGE_BUCKET, name: STORAGE_BUCKET, public: true })
    });
  } catch (e) {
    // se o bucket ja existir (ou a criacao falhar por outro motivo), so seguimos;
    // o upload abaixo e' quem vai de fato acusar erro se algo estiver errado.
  }
  bucketVerificado = true;
}

async function uploadArquivo(caminho, buffer, contentType) {
  await garantirBucket();
  const url = `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${caminho}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': contentType || 'application/octet-stream',
      'x-upsert': 'true'
    },
    body: buffer
  });
  if (!r.ok) {
    const texto = await r.text().catch(() => '');
    throw new Error(`Falha no upload (${r.status}): ${texto}`);
  }
  return `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${caminho}`;
}

async function removerArquivo(caminho) {
  try {
    await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${caminho}`, {
      method: 'DELETE',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
    });
  } catch (e) {
    // melhor esforco: se nao conseguir remover o arquivo antigo, nao trava o app
  }
}

function nomeSeguro(nome) {
  return String(nome || 'arquivo').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function dataUrlParaBuffer(dataUrl) {
  const partes = String(dataUrl).split(',');
  const cabecalho = partes[0] || '';
  const base64 = partes[1] || '';
  const match = cabecalho.match(/data:(.*?);base64/);
  const mime = (match && match[1]) ? match[1] : 'application/octet-stream';
  return { buffer: Buffer.from(base64, 'base64'), mime };
}

// ---------- migracao de anexos antigos (base64 -> Storage) ----------
// Roda em lotes pequenos por requisicao, para nao estourar o tempo limite
// de requisicao do plano gratis do Render. O botao no app chama essa rota
// varias vezes seguidas ate nao sobrar mais nada para migrar.

function coletarAnexosPendentes(data) {
  const pendentes = [];
  const entries = (data && data.naoconformidades && Array.isArray(data.naoconformidades.entries))
    ? data.naoconformidades.entries : [];
  entries.forEach(entry => {
    ['fotos', 'videos', 'documentos'].forEach(campo => {
      (entry[campo] || []).forEach(item => {
        if (item && item.dataUrl && !item.url) pendentes.push(item);
      });
    });
  });
  return pendentes;
}

async function migrarUmAnexo(item) {
  const { buffer, mime } = dataUrlParaBuffer(item.dataUrl);
  const caminho = `migracao-${Date.now()}-${crypto.randomBytes(6).toString('hex')}-${nomeSeguro(item.name)}`;
  const url = await uploadArquivo(caminho, buffer, item.type || mime);
  item.url = url;
  item.path = caminho;
  delete item.dataUrl;
}

// ---------- servidor ----------

const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];

  // login/logout ficam sempre acessiveis, sem exigir sessao
  if (urlPath === '/api/login' && req.method === 'POST') {
    try {
      const { usuario, senha } = await lerCorpoJSON(req);
      if (usuario === LOGIN_USER && senha === LOGIN_PASS) {
        sendJSON(res, 200, { ok: true }, { 'Set-Cookie': criarCookieSessao(usuario) });
      } else {
        sendJSON(res, 401, { error: 'Usuario ou senha incorretos' });
      }
    } catch (e) {
      sendJSON(res, 400, { error: 'Requisicao invalida' });
    }
    return;
  }

  if (urlPath === '/api/logout' && req.method === 'POST') {
    sendJSON(res, 200, { ok: true }, { 'Set-Cookie': cookieLogout() });
    return;
  }

  // rota publica e leve, so para servicos de keep-alive evitarem que o app durma
  if (urlPath === '/ping') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (urlPath === '/login') {
    serveFile(res, path.join(__dirname, 'public', 'login.html'));
    return;
  }

  // icones e manifest sao publicos (precisam carregar ate na tela de login)
  if (urlPath === '/manifest.json' || urlPath.startsWith('/icons/') || urlPath.startsWith('/splash/')) {
    const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
    serveFile(res, path.join(__dirname, 'public', safePath));
    return;
  }

  // tudo daqui pra baixo exige sessao valida
  const autenticado = estaAutenticado(req);

  if (urlPath === '/api/estado' && req.method === 'GET') {
    if (!autenticado) { sendJSON(res, 401, { error: 'Nao autenticado' }); return; }
    try {
      const data = await getEstado();
      sendJSON(res, 200, { data });
    } catch (e) {
      console.error(e);
      sendJSON(res, 500, { error: 'Falha ao ler dados do Supabase' });
    }
    return;
  }

  if (urlPath === '/api/estado' && req.method === 'PUT') {
    if (!autenticado) { sendJSON(res, 401, { error: 'Nao autenticado' }); return; }
    try {
      const parsed = await lerCorpoJSON(req);
      await saveEstado(parsed);
      sendJSON(res, 200, { ok: true });
    } catch (e) {
      console.error(e);
      sendJSON(res, 500, { error: 'Falha ao salvar dados no Supabase' });
    }
    return;
  }

  if (urlPath === '/api/upload' && req.method === 'POST') {
    if (!autenticado) { sendJSON(res, 401, { error: 'Nao autenticado' }); return; }
    try {
      const { nome, tipo, dataBase64 } = await lerCorpoJSON(req);
      if (!dataBase64) { sendJSON(res, 400, { error: 'Arquivo vazio' }); return; }
      const buffer = Buffer.from(dataBase64, 'base64');
      const caminho = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}-${nomeSeguro(nome)}`;
      const url = await uploadArquivo(caminho, buffer, tipo);
      sendJSON(res, 200, { ok: true, url, path: caminho });
    } catch (e) {
      console.error(e);
      sendJSON(res, 500, { error: 'Falha ao enviar arquivo' });
    }
    return;
  }

  if (urlPath === '/api/upload' && req.method === 'DELETE') {
    if (!autenticado) { sendJSON(res, 401, { error: 'Nao autenticado' }); return; }
    try {
      const { path: caminho } = await lerCorpoJSON(req);
      if (caminho) await removerArquivo(caminho);
      sendJSON(res, 200, { ok: true });
    } catch (e) {
      console.error(e);
      sendJSON(res, 500, { error: 'Falha ao remover arquivo' });
    }
    return;
  }

  if (urlPath === '/api/migrar-anexos' && req.method === 'POST') {
    if (!autenticado) { sendJSON(res, 401, { error: 'Nao autenticado' }); return; }
    try {
      const data = await getEstado();
      const pendentes = coletarAnexosPendentes(data);
      const LOTE = 5; // poucos por vez, para nao estourar o tempo de requisicao do plano gratis
      const lote = pendentes.slice(0, LOTE);
      let migrados = 0, falhas = 0;
      for (const item of lote) {
        try { await migrarUmAnexo(item); migrados++; }
        catch (e) { falhas++; console.error('Falha ao migrar anexo:', e.message); }
      }
      if (migrados > 0) await saveEstado(data);
      const restantes = coletarAnexosPendentes(data).length;
      sendJSON(res, 200, { ok: true, migrados, falhas, restantes });
    } catch (e) {
      console.error(e);
      sendJSON(res, 500, { error: 'Falha na migracao' });
    }
    return;
  }

  if (urlPath === '/' || urlPath === '/index.html') {
    if (!autenticado) { res.writeHead(302, { Location: '/login' }); res.end(); return; }
    serveFile(res, path.join(__dirname, 'public', 'index.html'));
    return;
  }

  res.writeHead(404); res.end('Nao encontrado');
});

server.listen(PORT, () => console.log(`Controle de Coletas rodando na porta ${PORT}`));
