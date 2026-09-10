// Script único de migração: pega as fotos, vídeos e PDFs que já estão
// salvos em base64 dentro do estado do app (o que deixa o carregamento
// pesado) e envia cada um deles para o Supabase Storage, trocando o
// conteúdo embutido por um link leve.
//
// Depois de rodar este script uma vez, o app volta a carregar rápido:
// o /api/estado passa a trafegar só texto (nomes e links), não os
// arquivos inteiros.
//
// COMO USAR:
//   1. Garanta que as mesmas variáveis de ambiente do server.js estão
//      configuradas nesta sessão: SUPABASE_URL e SUPABASE_SERVICE_KEY
//      (e SUPABASE_STORAGE_BUCKET, se você tiver mudado o padrão).
//      No Render: aba "Shell" do serviço já vem com essas variáveis
//      carregadas automaticamente.
//   2. Rode:  node migrar-anexos.js
//   3. Acompanhe o log no terminal.
//
// É seguro rodar mais de uma vez: o script só mexe em anexos que ainda
// têm "dataUrl" (base64) e ainda não têm "url" (ou seja, já migrado é
// pulado). Se algum upload falhar (ex.: sem internet no meio do processo),
// o anexo original fica intacto e você pode simplesmente rodar de novo.

const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TABLE = 'estado_frota';
const ROW_ID = 'frota';
const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'nc-anexos';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Erro: configure SUPABASE_URL e SUPABASE_SERVICE_KEY antes de rodar este script.');
  process.exit(1);
}

async function getEstado() {
  const url = `${SUPABASE_URL}/rest/v1/${TABLE}?id=eq.${ROW_ID}&select=data`;
  const r = await fetch(url, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  });
  if (!r.ok) throw new Error(`Falha ao ler estado do Supabase: ${r.status}`);
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
  if (!r.ok) throw new Error(`Falha ao salvar estado no Supabase: ${r.status}`);
}

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
    // se o bucket ja existir, so seguimos - o upload denuncia erro de verdade
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
    throw new Error(`upload falhou (${r.status}): ${texto}`);
  }
  return `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${caminho}`;
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

let totalMigrados = 0;
let totalBytesEconomizados = 0;
let totalFalhas = 0;

async function migrarItem(item, rotulo) {
  if (!item || item.url || !item.dataUrl) return item; // ja migrado, ou sem conteudo
  try {
    const { buffer, mime } = dataUrlParaBuffer(item.dataUrl);
    const caminho = `migracao-${Date.now()}-${crypto.randomBytes(6).toString('hex')}-${nomeSeguro(item.name)}`;
    const url = await uploadArquivo(caminho, buffer, item.type || mime);
    totalMigrados++;
    totalBytesEconomizados += buffer.length;
    console.log(`  [ok]   ${rotulo} "${item.name || caminho}" -> ${url}`);
    const migrado = Object.assign({}, item, { url, path: caminho });
    delete migrado.dataUrl;
    return migrado;
  } catch (e) {
    totalFalhas++;
    console.error(`  [erro] ${rotulo} "${item.name || '?'}": ${e.message}`);
    return item; // mantem como estava se der erro, para nao perder o anexo
  }
}

async function migrarLista(lista, rotulo) {
  if (!Array.isArray(lista) || !lista.length) return lista;
  const nova = [];
  for (const item of lista) {
    nova.push(await migrarItem(item, rotulo));
  }
  return nova;
}

async function main() {
  console.log('Lendo estado atual do Supabase...\n');
  const data = await getEstado();
  if (!data || !data.naoconformidades || !Array.isArray(data.naoconformidades.entries)) {
    console.log('Nenhuma não conformidade encontrada. Nada para migrar.');
    return;
  }

  const entries = data.naoconformidades.entries;
  console.log(`Encontradas ${entries.length} não conformidades. Verificando anexos...\n`);

  for (const entry of entries) {
    const rotulo = `NC nº ${entry.num_inspecao || entry.id || '?'}`;
    const temPendente =
      (entry.fotos || []).some(f => f && f.dataUrl && !f.url) ||
      (entry.videos || []).some(v => v && v.dataUrl && !v.url) ||
      (entry.documentos || []).some(d => d && d.dataUrl && !d.url);
    if (temPendente) console.log(`${rotulo}:`);

    entry.fotos = await migrarLista(entry.fotos, `${rotulo} / foto`);
    entry.videos = await migrarLista(entry.videos, `${rotulo} / vídeo`);
    entry.documentos = await migrarLista(entry.documentos, `${rotulo} / documento`);
  }

  console.log('\nSalvando estado atualizado no Supabase...');
  await saveEstado(data);

  console.log('\n===== Resumo da migração =====');
  console.log(`Arquivos migrados: ${totalMigrados}`);
  console.log(`Falhas: ${totalFalhas}`);
  console.log(`Espaço removido do bloco de dados principal: ~${(totalBytesEconomizados / 1024 / 1024).toFixed(1)} MB`);
  if (totalFalhas > 0) {
    console.log('Alguns arquivos falharam e continuam como estavam - rode o script de novo para tentar migrá-los.');
  }
  console.log('Pronto! Da próxima vez que o app carregar, esse peso não estará mais lá.');
}

main().catch(e => {
  console.error('\nErro fatal na migração:', e);
  process.exit(1);
});
