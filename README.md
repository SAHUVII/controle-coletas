# Controle de Coletas — Frota

App para controlar as datas de coleta das gravações dos caminhões (por placa, frota e processo). Node.js puro (sem framework), com login de usuário/senha fixos, dados salvos no Supabase, hospedado no Render — mesmo esquema do projeto Controle de Contas.

## 1. Criar a tabela no Supabase

No projeto Supabase que você já usa (ou um novo), rode no SQL Editor:

```sql
create table estado_frota (
  id text primary key,
  data jsonb,
  updated_at timestamptz default now()
);
```

## 2. Variáveis de ambiente

| Variável | Para que serve |
|---|---|
| `SUPABASE_URL` | URL do seu projeto Supabase (ex.: `https://xxxx.supabase.co`) |
| `SUPABASE_SERVICE_KEY` | A **service_role key** do Supabase (Project Settings → API). Nunca vai para o front-end, só o servidor usa. |
| `LOGIN_USER` | Usuário fixo para entrar no app |
| `LOGIN_PASS` | Senha fixa para entrar no app |
| `SESSION_SECRET` | Uma string aleatória qualquer, usada para assinar o cookie de login (ex.: gere uma em https://generate-secret.vercel.app/32) |

Se você já usa o mesmo projeto Supabase do Controle de Contas, pode reaproveitar `SUPABASE_URL` e `SUPABASE_SERVICE_KEY`; só muda a tabela (`estado_frota` em vez da tabela do outro app). Para `LOGIN_USER`/`LOGIN_PASS`, use os mesmos valores que já usa lá, se quiser o mesmo login.

Se `LOGIN_USER`/`LOGIN_PASS` não forem definidas, o app usa `admin`/`admin` como padrão (não deixe assim em produção).

## 3. Rodar localmente (opcional, para testar antes)

```bash
cd controle-coletas-site
SUPABASE_URL=https://xxxx.supabase.co SUPABASE_SERVICE_KEY=sua-service-key LOGIN_USER=seu-usuario LOGIN_PASS=sua-senha SESSION_SECRET=algo-aleatorio npm start
```

Abra `http://localhost:3000` — vai te levar para `/login` primeiro.

## 4. Subir para o GitHub

Crie um repositório (ou uma pasta dentro de um repositório existente, como fez com o Controle de Contas) e suba estes arquivos:

```
controle-coletas-site/
├── server.js
├── package.json
├── README.md
└── public/
    ├── index.html
    └── login.html
```

## 5. Deploy no Render

1. No Render, **New → Web Service**, aponte para o repositório.
2. Se o projeto estiver numa subpasta, defina o **Root Directory** como `controle-coletas-site`.
3. Build Command: `npm install` (não tem dependências externas, mas não faz mal deixar).
4. Start Command: `npm start`
5. Em **Environment**, adicione `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `LOGIN_USER`, `LOGIN_PASS` e `SESSION_SECRET`.
6. Deploy. O Render te dá uma URL própria (tipo `https://controle-coletas.onrender.com`) que funciona em qualquer navegador — computador, celular, tablet. Ao abrir, ele pede login antes de mostrar a tabela.

## Como funciona o login

- Usuário e senha são fixos, definidos nas variáveis de ambiente — não existe cadastro nem tela de "criar conta".
- Ao entrar, o servidor grava um cookie assinado (30 dias) que mantém a sessão. Não há tabela de sessões nem nada guardado no banco — só o cookie no navegador.
- O botão **Sair**, no topo do app, apaga esse cookie e volta para a tela de login.

## Observação sobre o plano free do Render

Assim como no Controle de Contas, no plano free o serviço "dorme" depois de um tempo sem uso e demora alguns segundos para acordar na primeira requisição. Os dados não se perdem porque ficam no Supabase, não no disco do Render.
