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

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL;
const FROM_NAME = process.env.FROM_NAME || 'Controle de Coletas';

if (!BREVO_API_KEY || !FROM_EMAIL) {
  console.warn('Aviso: BREVO_API_KEY / FROM_EMAIL nao configuradas. O envio de e-mail da aba "Email NC" vai falhar ate configurar essas variaveis.');
}

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

function sendHTML(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
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

function lerCorpoFormulario(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const out = {};
      new URLSearchParams(body).forEach((v, k) => { out[k] = v; });
      resolve(out);
    });
    req.on('error', reject);
  });
}

// ---------- E-mail (Brevo, via HTTPS) ----------
// Usa a API HTTP da Brevo em vez de SMTP porque o Render bloqueia portas
// SMTP (25/465/587) de saida no plano gratuito.

async function enviarEmailBrevo({ to, cc, subject, html, pdfBase64, filename }) {
  if (!BREVO_API_KEY) throw new Error('BREVO_API_KEY nao configurada.');
  if (!FROM_EMAIL) throw new Error('FROM_EMAIL nao configurado.');

  const body = {
    sender: { name: FROM_NAME, email: FROM_EMAIL },
    to: [{ email: to }],
    subject,
    htmlContent: html
  };
  if (cc && cc.length) body.cc = cc.map((email) => ({ email }));
  if (pdfBase64) body.attachment = [{ content: pdfBase64, name: filename || 'anexo.pdf' }];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let resp;
  try {
    resp = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Tempo esgotado ao tentar enviar o e-mail (Brevo nao respondeu a tempo).');
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    let detalhe = '';
    try { detalhe = (await resp.json()).message || ''; } catch (e) { /* ignora */ }
    throw new Error(`Falha ao enviar e-mail (Brevo respondeu ${resp.status}). ${detalhe}`);
  }
}

// ---------- paginas publicas simples (aprovar/reprovar) ----------

function paginaSimples(titulo, mensagem, cor) {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1"><title>${titulo}</title>
  <style>
    body{font-family:Arial,sans-serif;background:#10131a;color:#eceff2;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;}
    .box{max-width:420px;text-align:center;background:#181c23;border:1px solid #2b313a;border-radius:14px;padding:32px 26px;}
    h1{font-size:1.2rem;margin-bottom:10px;color:${cor || '#eceff2'};}
    p{color:#8c95a2;font-size:0.92rem;line-height:1.6;}
  </style></head><body><div class="box"><h1>${titulo}</h1><p>${mensagem}</p></div></body></html>`;
}
function paginaConfirmacao(titulo, corBotao, textoBotao, formAction, extraCampo) {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1"><title>${titulo}</title>
  <style>
    body{font-family:Arial,sans-serif;background:#10131a;color:#eceff2;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;}
    .box{max-width:440px;width:100%;background:#181c23;border:1px solid #2b313a;border-radius:14px;padding:32px 26px;}
    h1{font-size:1.15rem;margin-bottom:14px;}
    textarea{width:100%;min-height:80px;border-radius:8px;border:1px solid #2b313a;background:#1f242c;color:#eceff2;padding:10px;font-family:Arial,sans-serif;margin-bottom:16px;box-sizing:border-box;}
    button{width:100%;padding:12px;border:none;border-radius:8px;background:${corBotao};color:#0d1013;font-weight:bold;font-size:0.95rem;cursor:pointer;}
  </style></head><body><div class="box">
    <h1>${titulo}</h1>
    <form method="POST" action="${formAction}">
      ${extraCampo || ''}
      <button type="submit">${textoBotao}</button>
    </form>
  </div></body></html>`;
}

async function processarDecisaoEmailNc(res, token, decisao, novoStatus, comentario) {
  let data;
  try { data = await getEstado(); }
  catch (e) { return sendHTML(res, 500, 'Erro interno. Tente novamente em instantes.'); }
  const entries = (data && data.emailnc && Array.isArray(data.emailnc.entries)) ? data.emailnc.entries : [];
  const entry = entries.find(e => e.approvalToken === token);
  if (!entry) {
    return sendHTML(res, 404, paginaSimples('Link invalido', 'Nao encontramos nenhuma tratativa associada a este link.', '#ef5b5b'));
  }
  if (entry.tokenUsedAt) {
    return sendHTML(res, 200, paginaSimples(
      'Ja respondida',
      `Esta tratativa ja foi marcada como <b>${entry.decision === 'aprovado' ? 'feita' : 'nao feita'}</b> anteriormente.`,
      '#8c95a2'
    ));
  }
  entry.status = novoStatus;
  entry.decision = decisao;
  entry.decisionComment = comentario || null;
  entry.decisionAt = new Date().toISOString();
  entry.tokenUsedAt = new Date().toISOString();
  await saveEstado(data);

  return sendHTML(res, 200, paginaSimples(
    decisao === 'aprovado' ? 'Obrigado pela confirmacao!' : 'Resposta registrada',
    decisao === 'aprovado'
      ? 'A tratativa foi marcada como <b>feita</b>. Quem lancou ja pode acompanhar essa atualizacao no sistema.'
      : 'A tratativa foi marcada como <b>nao feita</b>. Quem lancou vai dar continuidade.',
    decisao === 'aprovado' ? '#3ecf8e' : '#ef5b5b'
  ));
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

  // paginas publicas de aprovacao da aba "Email NC" (quem clica e' o destinatario do e-mail, sem login)
  if (urlPath.startsWith('/aprovar/') && req.method === 'GET') {
    const token = urlPath.split('/')[2];
    return sendHTML(res, 200, paginaConfirmacao('Confirmar tratativa como feita', '#3ecf8e', 'Confirmar que foi feita', `/aprovar/${token}`));
  }
  if (urlPath.startsWith('/aprovar/') && req.method === 'POST') {
    const token = urlPath.split('/')[2];
    return await processarDecisaoEmailNc(res, token, 'aprovado', 'Concluído', null);
  }
  if (urlPath.startsWith('/reprovar/') && req.method === 'GET') {
    const token = urlPath.split('/')[2];
    return sendHTML(res, 200, paginaConfirmacao(
      'Confirmar que não foi feita', '#ef5b5b', 'Confirmar que não foi feita', `/reprovar/${token}`,
      `<textarea name="comentario" placeholder="Motivo (opcional)"></textarea>`
    ));
  }
  if (urlPath.startsWith('/reprovar/') && req.method === 'POST') {
    const token = urlPath.split('/')[2];
    const form = await lerCorpoFormulario(req);
    return await processarDecisaoEmailNc(res, token, 'reprovado', 'Vencido', form.comentario || null);
  }

  // tudo daqui pra baixo exige sessao valida
  const autenticado = estaAutenticado(req);

  if (urlPath === '/api/enviar-email-nc' && req.method === 'POST') {
    if (!autenticado) { sendJSON(res, 401, { error: 'Nao autenticado' }); return; }
    try {
      const { to, cc, subject, html, pdfBase64, filename } = await lerCorpoJSON(req);
      if (!to) { sendJSON(res, 400, { error: 'Destinatario nao informado.' }); return; }
      await enviarEmailBrevo({ to, cc, subject, html, pdfBase64, filename });
      sendJSON(res, 200, { ok: true });
    } catch (e) {
      console.error('Falha ao enviar e-mail (Email NC):', e.message);
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

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

  // fallback: qualquer outro arquivo dentro de public/ (ex.: nc-codes.js) e' servido aqui.
  // Isso faltava no servidor original, que so conhecia arquivos especificos (icones, manifest, etc.).
  if (req.method === 'GET') {
    const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
    const publicDir = path.join(__dirname, 'public');
    const candidato = path.join(publicDir, safePath);
    if (candidato.startsWith(publicDir) && fs.existsSync(candidato) && fs.statSync(candidato).isFile()) {
      serveFile(res, candidato);
      return;
    }
  }

  res.writeHead(404); res.end('Nao encontrado');
});

server.listen(PORT, () => console.log(`Controle de Coletas rodando na porta ${PORT}`));
