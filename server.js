const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = Number(process.env.PORT) || 3000;
const SENHA_ADMIN = process.env.ADMIN_SENHA || 'wagner123';
const PASTA_DADOS = process.env.DATA_DIR || path.join(__dirname, 'data');
const ARQUIVO = path.join(PASTA_DADOS, 'dados.json');

const PADRAO = {
  config: {
    limiteMinutos: 5,
    estado: 'aberto', // aberto | pausado | fechado
    // {nome} (só o primeiro nome), {numero} e {minutos} são trocados pelos dados do cliente
    mensagem:
      'Olá, {nome}! Chegou a sua vez de cortar na Barbearia do Wagner (senha Nº {numero}). ' +
      'Você tem tolerância de {minutos} minutos para se apresentar. Depois disso, a vez passa para o próximo da fila.',
  },
  contador: 0, // número da senha do dia
  ordem: 0, // posição na fila (permite reinserir alguém no fim)
  fila: [], // clientes do dia
  historico: [], // dias anteriores (para o total geral)
  segredo: null,
};

// ---------- Persistência ----------

function carregar() {
  try {
    const d = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
    return { ...PADRAO, ...d, config: { ...PADRAO.config, ...d.config } };
  } catch {
    return structuredClone(PADRAO);
  }
}

const db = carregar();
if (!db.segredo) db.segredo = crypto.randomBytes(16).toString('hex');

let timerSalvar;
function salvar() {
  clearTimeout(timerSalvar);
  timerSalvar = setTimeout(() => {
    fs.mkdirSync(PASTA_DADOS, { recursive: true });
    const conteudo = JSON.stringify(db, null, 2);
    const tmp = ARQUIVO + '.tmp';
    try {
      fs.writeFileSync(tmp, conteudo);
      fs.renameSync(tmp, ARQUIVO);
    } catch {
      fs.writeFileSync(ARQUIVO, conteudo); // OneDrive às vezes bloqueia o rename
    }
  }, 200);
}
salvar();

// ---------- Regras da fila ----------

const limiteMs = () => db.config.limiteMinutos * 60 * 1000;
const aguardando = () => db.fila.filter((c) => c.status === 'aguardando').sort((a, b) => a.ordem - b.ordem);
const atual = () => db.fila.find((c) => c.status === 'chamado' || c.status === 'atendendo');
const buscar = (id) => db.fila.find((c) => c.id === id);

function chamar(cliente) {
  cliente.status = 'chamado';
  cliente.chamadoEm = Date.now();
}

// Se a cadeira está livre e a fila aberta, chama o próximo automaticamente.
function avancar() {
  if (db.config.estado !== 'aberto' || atual()) return;
  const proximo = aguardando()[0];
  if (proximo) chamar(proximo);
}

function mudou() {
  avancar();
  salvar();
  transmitir();
}

// Passou do tempo limite sem se apresentar: perde a vez e chama o próximo.
setInterval(() => {
  const a = atual();
  if (a && a.status === 'chamado' && Date.now() - a.chamadoEm >= limiteMs()) {
    a.status = 'expirado';
    a.finalizadoEm = Date.now();
    mudou();
  }
}, 1000);

function mediaAtendimentoMs() {
  const feitos = db.historico
    .concat(db.fila)
    // ignora cortes finalizados sem ter clicado em "Chegou" (duração ~0)
    .filter((c) => c.status === 'concluido' && c.iniciadoEm && c.finalizadoEm - c.iniciadoEm >= 2 * 60 * 1000)
    .slice(-20);
  if (!feitos.length) return 30 * 60 * 1000;
  const soma = feitos.reduce((s, c) => s + (c.finalizadoEm - c.iniciadoEm), 0);
  return Math.round(soma / feitos.length);
}

function nomeCurto(nome) {
  const partes = nome.trim().split(/\s+/);
  return partes.length > 1 ? `${partes[0]} ${partes[partes.length - 1][0]}.` : partes[0];
}

function mensagemVez(c) {
  return db.config.mensagem
    .replaceAll('{nome}', c.nome.split(' ')[0])
    .replaceAll('{numero}', c.numero)
    .replaceAll('{minutos}', db.config.limiteMinutos);
}

// Data local (AAAA-MM-DD), para o dia não virar às 21h por causa do fuso
function diaLocal(ms = Date.now()) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function estatisticas() {
  const concluidos = (lista) => lista.filter((c) => c.status === 'concluido');
  const hoje = concluidos(db.fila);
  const todos = concluidos(db.historico.concat(db.fila));

  // Cortes nos últimos 7 dias de trabalho (hoje incluso, mesmo se o dia já foi encerrado uma vez)
  const porDia = new Map();
  for (const c of concluidos(db.historico)) porDia.set(c.dia, (porDia.get(c.dia) || 0) + 1);
  const dataHoje = diaLocal();
  const cortesHoje = (porDia.get(dataHoje) || 0) + hoje.length;
  porDia.delete(dataHoje);
  const ultimosDias = [...porDia.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-6)
    .map(([dia, total]) => ({ dia, total }));
  ultimosDias.push({ dia: dataHoje, total: cortesHoje, hoje: true });

  return {
    cortesHoje,
    cortesTotal: todos.length,
    naFila: aguardando().length,
    perderamVez: db.fila.filter((c) => c.status === 'expirado').length,
    manuaisHoje: hoje.filter((c) => c.origem === 'manual').length,
    mediaMs: mediaAtendimentoMs(),
    ultimosDias,
  };
}

function estadoPublico(idCliente) {
  const a = atual();
  const fila = aguardando();
  const meu = idCliente ? buscar(idCliente) : null;
  let minha = null;
  if (meu) {
    const posicao = fila.findIndex((c) => c.id === meu.id);
    minha = {
      numero: meu.numero,
      nome: meu.nome,
      status: meu.status,
      chamadoEm: meu.chamadoEm || null,
      aFrente: posicao >= 0 ? posicao + (a ? 1 : 0) : null,
      proximo: posicao === 0,
      mensagem: meu.status === 'chamado' ? mensagemVez(meu) : null,
    };
  }
  return {
    agora: Date.now(),
    estado: db.config.estado,
    limiteMs: limiteMs(),
    limiteMinutos: db.config.limiteMinutos,
    mediaMs: mediaAtendimentoMs(),
    atual: a ? { numero: a.numero, nome: nomeCurto(a.nome), status: a.status, chamadoEm: a.chamadoEm } : null,
    fila: fila.map((c) => ({ numero: c.numero, nome: nomeCurto(c.nome) })),
    minha,
    // id informado mas não existe mais (ex.: Wagner encerrou o dia)
    senhaInvalida: Boolean(idCliente && !meu),
  };
}

function estadoAdmin() {
  const a = atual();
  return {
    agora: Date.now(),
    config: db.config,
    limiteMs: limiteMs(),
    atual: a ? { ...a, mensagem: mensagemVez(a) } : null,
    fila: aguardando(),
    encerrados: db.fila
      .filter((c) => ['concluido', 'expirado', 'cancelado'].includes(c.status))
      .sort((a, b) => (b.finalizadoEm || 0) - (a.finalizadoEm || 0)),
    stats: estatisticas(),
  };
}

// ---------- Tempo real (Server-Sent Events) ----------

const conexoes = new Set();

function enviar(con) {
  const dados = con.admin ? estadoAdmin() : estadoPublico(con.id);
  con.res.write(`data: ${JSON.stringify(dados)}\n\n`);
}

function transmitir() {
  for (const con of conexoes) enviar(con);
}

function abrirStream(req, res, con) {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  con.res = res;
  conexoes.add(con);
  enviar(con);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    conexoes.delete(con);
  });
}

// ---------- Validação ----------

const MINUSCULAS = new Set(['da', 'de', 'do', 'das', 'dos', 'e']);

// "joão DA silva" -> "João da Silva"
function capitalizar(nome) {
  return nome
    .toLowerCase()
    .split(' ')
    .map((p, i) => (i > 0 && MINUSCULAS.has(p) ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(' ');
}

// O cliente precisa informar nome e sobrenome e WhatsApp; o Wagner pode cadastrar sem telefone.
function lerCliente(body, origem) {
  const nome = capitalizar(String(body.nome || '').trim().replace(/\s+/g, ' '));
  let telefone = String(body.telefone || '').replace(/\D/g, '');
  if (telefone.length >= 12 && telefone.startsWith('55')) telefone = telefone.slice(2);

  if (!/^[\p{L}' -]+$/u.test(nome)) return { erro: 'O nome deve ter apenas letras.' };
  if (nome.length > 40) return { erro: 'Nome muito longo (máximo 40 letras).' };
  const partes = nome.split(' ').filter((p) => p.length >= 2);
  if (origem === 'cliente' && partes.length < 2) return { erro: 'Informe seu nome e sobrenome, para o Wagner saber quem é você.' };
  if (!partes.length) return { erro: 'Informe o nome do cliente.' };

  const telefoneValido = telefone.length === 10 || telefone.length === 11;
  if (origem === 'cliente' && !telefoneValido) return { erro: 'Informe seu WhatsApp com DDD. Ex.: (11) 98765-4321' };
  if (telefone && !telefoneValido) return { erro: 'Telefone inválido. Use DDD + número.' };

  return { nome, telefone };
}

function novoCliente(dados, origem) {
  const cliente = {
    id: crypto.randomUUID(),
    numero: ++db.contador,
    ordem: ++db.ordem,
    ...dados,
    origem,
    status: 'aguardando',
    criadoEm: Date.now(),
  };
  db.fila.push(cliente);
  mudou();
  return cliente;
}

// ---------- Rotas ----------

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.get('/api/stream', (req, res) => abrirStream(req, res, { id: String(req.query.id || '') || null }));

app.post('/api/entrar', (req, res) => {
  if (db.config.estado === 'fechado') return res.status(400).json({ erro: 'A fila está fechada no momento.' });
  const dados = lerCliente(req.body, 'cliente');
  if (dados.erro) return res.status(400).json(dados);
  const c = novoCliente(dados, 'cliente');
  res.json({ id: c.id, numero: c.numero });
});

app.post('/api/sair', (req, res) => {
  const c = buscar(String(req.body.id || ''));
  if (c && (c.status === 'aguardando' || c.status === 'chamado')) {
    c.status = 'cancelado';
    c.finalizadoEm = Date.now();
    mudou();
  }
  res.json({ ok: true });
});

// --- Área do Wagner ---

const tokenAdmin = () => crypto.createHmac('sha256', db.segredo).update(SENHA_ADMIN).digest('hex');

app.post('/api/admin/login', (req, res) => {
  if (String(req.body.senha || '') !== SENHA_ADMIN) return res.status(401).json({ erro: 'Senha incorreta.' });
  res.json({ token: tokenAdmin() });
});

function autenticado(req, res, next) {
  const token = req.get('x-token') || req.query.token;
  if (token !== tokenAdmin()) return res.status(401).json({ erro: 'Faça login novamente.' });
  next();
}

app.get('/api/admin/stream', autenticado, (req, res) => abrirStream(req, res, { admin: true }));

let portaAtual = PORT;

// Endereços na rede local (Wi‑Fi/cabo), ignorando adaptadores virtuais do Docker/WSL
function enderecosRede() {
  return Object.entries(os.networkInterfaces())
    .filter(([nome]) => !/vethernet|wsl|docker|virtualbox|vmware|hyper-v/i.test(nome))
    .flatMap(([, lista]) => lista)
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => `http://${i.address}:${portaAtual}`);
}

app.get('/api/admin/info', autenticado, (req, res) => {
  res.json({ enderecos: enderecosRede() });
});

app.post('/api/admin/adicionar', autenticado, (req, res) => {
  const dados = lerCliente(req.body, 'manual');
  if (dados.erro) return res.status(400).json(dados);
  const c = novoCliente(dados, 'manual');
  res.json({ numero: c.numero });
});

app.post('/api/admin/acao', autenticado, (req, res) => {
  const c = buscar(String(req.body.id || ''));
  if (!c) return res.status(404).json({ erro: 'Cliente não encontrado.' });
  const agora = Date.now();

  switch (req.body.acao) {
    case 'chamar': // chama alguém da fila manualmente (ex.: fila pausada)
      if (atual()) return res.status(400).json({ erro: 'Já tem alguém na cadeira.' });
      if (c.status !== 'aguardando') return res.status(400).json({ erro: 'Cliente não está na fila.' });
      chamar(c);
      break;
    case 'chegou':
      if (c.status !== 'chamado') return res.status(400).json({ erro: 'Cliente não foi chamado.' });
      c.status = 'atendendo';
      c.iniciadoEm = agora;
      break;
    case 'proximo': { // conta o corte de quem está na cadeira e já chama o próximo
      if (c.status !== 'atendendo') return res.status(400).json({ erro: 'Cliente não está na cadeira.' });
      c.status = 'concluido';
      c.finalizadoEm = agora;
      const proximo = aguardando()[0];
      if (proximo) chamar(proximo); // chama mesmo com a fila em pausa: foi o Wagner que pediu
      break;
    }
    case 'pular':
      if (c.status !== 'chamado') return res.status(400).json({ erro: 'Cliente não foi chamado.' });
      c.status = 'expirado';
      c.finalizadoEm = agora;
      break;
    case 'remover':
      if (c.status !== 'aguardando') return res.status(400).json({ erro: 'Cliente não está na fila.' });
      c.status = 'cancelado';
      c.finalizadoEm = agora;
      break;
    case 'reinserir': // quem perdeu a vez volta para o fim da fila
      if (c.status !== 'expirado' && c.status !== 'cancelado') return res.status(400).json({ erro: 'Ação inválida.' });
      c.status = 'aguardando';
      c.ordem = ++db.ordem;
      delete c.chamadoEm;
      delete c.finalizadoEm;
      break;
    default:
      return res.status(400).json({ erro: 'Ação inválida.' });
  }
  mudou();
  res.json({ ok: true });
});

app.post('/api/admin/estado', autenticado, (req, res) => {
  if (!['aberto', 'pausado', 'fechado'].includes(req.body.estado)) return res.status(400).json({ erro: 'Estado inválido.' });
  db.config.estado = req.body.estado;
  mudou();
  res.json({ ok: true });
});

app.post('/api/admin/config', autenticado, (req, res) => {
  const limite = Number(req.body.limiteMinutos);
  if (!(limite >= 1 && limite <= 60)) return res.status(400).json({ erro: 'Tempo limite entre 1 e 60 minutos.' });
  const mensagem = String(req.body.mensagem || '').trim().slice(0, 500);
  if (!mensagem) return res.status(400).json({ erro: 'Escreva a mensagem padrão.' });
  db.config.limiteMinutos = limite;
  db.config.mensagem = mensagem;
  mudou();
  res.json({ ok: true });
});

app.post('/api/admin/encerrar-dia', autenticado, (req, res) => {
  const dia = diaLocal();
  for (const c of db.fila) {
    if (c.status === 'aguardando' || c.status === 'chamado') c.status = 'cancelado';
    if (c.status === 'atendendo') {
      c.status = 'concluido';
      c.finalizadoEm = Date.now();
    }
    db.historico.push({ ...c, dia });
  }
  db.fila = [];
  db.contador = 0;
  mudou();
  res.json({ ok: true });
});

// Se a porta estiver ocupada (ex.: Docker), tenta a próxima livre
function iniciar(porta, tentativas = 10) {
  const servidor = app.listen(porta, () => {
    portaAtual = porta;
    const rede = enderecosRede()[0];
    console.log(`\n  Barbearia do Wagner — fila rodando`);
    console.log(`  Clientes: ${rede || `http://localhost:${porta}`}`);
    console.log(`  Wagner:   http://localhost:${porta}/admin  (senha: ${process.env.ADMIN_SENHA ? '[definida em ADMIN_SENHA]' : SENHA_ADMIN})\n`);
  });
  servidor.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && tentativas > 0) {
      console.log(`  Porta ${porta} ocupada, tentando ${porta + 1}...`);
      iniciar(porta + 1, tentativas - 1);
    } else {
      throw err;
    }
  });
}
iniciar(PORT);
