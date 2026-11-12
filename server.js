// Horário de Brasília mesmo em servidor fora do Brasil (a Render roda em UTC)
process.env.TZ ||= 'America/Sao_Paulo';

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const QRCode = require('qrcode');
const criarArmazenamento = require('./armazenamento');

const PORT = Number(process.env.PORT) || 3000;
const SENHA_ADMIN = process.env.ADMIN_SENHA || 'wagner123';
const EM_PRODUCAO = Boolean(process.env.RENDER || process.env.NODE_ENV === 'production');

// Na Render o disco normal é apagado a cada deploy: o banco tem que ficar no Persistent Disk.
if (EM_PRODUCAO && !process.env.DATA_DIR) {
  console.error('ERRO: em produção defina DATA_DIR com a pasta do Persistent Disk (ex.: /var/data). Sem isso, cada deploy apagaria o banco.');
  process.exit(1);
}
if (EM_PRODUCAO && !process.env.ADMIN_SENHA) {
  console.error('ERRO: em produção defina ADMIN_SENHA (a senha do painel do Wagner).');
  process.exit(1);
}

const armazenamento = criarArmazenamento({ pasta: process.env.DATA_DIR || path.join(__dirname, 'data') });

const PADRAO = {
  config: {
    limiteMinutos: 5,
    estado: 'aberto', // aberto | pausado | fechado
    // {nome} (só o primeiro nome), {numero} e {minutos} são trocados pelos dados do cliente
    mensagem:
      'Olá, {nome}! Chegou a sua vez de cortar na Barbearia do Wagner (senha Nº {numero}). ' +
      'Você tem tolerância de {minutos} minutos para se apresentar. Depois disso, a vez passa para o próximo da fila.',
    recado: '', // aviso que aparece no topo da tela do cliente (ex.: "Hoje atendo até 22h")
    limiteSenhas: 0, // máximo de senhas por dia pelo celular (0 = sem limite)
  },
  diaAtual: null, // dia de trabalho da fila atual (AAAA-MM-DD)
  contador: 0, // número da senha do dia
  ordem: 0, // posição na fila (permite reinserir alguém no fim)
  fila: [], // clientes do dia
  historico: [], // dias anteriores (para o total geral)
  segredo: null,
};

// O dia de trabalho vira às 4h, não à meia-noite: o atendimento do dia 31 pode passar da meia-noite.
const HORA_VIRADA = 4;

function diaDeTrabalho(ms = Date.now()) {
  const d = new Date(ms - HORA_VIRADA * 60 * 60 * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------- Persistência ----------

// Preenchido em iniciar(), a partir do que estiver salvo
const db = structuredClone(PADRAO);
let pronto = false;

async function carregarDados() {
  const salvo = await armazenamento.carregar(); // erro aqui derruba o servidor de propósito
  if (salvo) Object.assign(db, salvo, { config: { ...PADRAO.config, ...salvo.config } });
  if (!db.segredo) db.segredo = crypto.randomBytes(16).toString('hex');
  if (!db.diaAtual) db.diaAtual = db.fila.length ? diaDeTrabalho(db.fila[0].criadoEm) : diaDeTrabalho();
}

// Gravações em sequência (nunca duas ao mesmo tempo) e agrupadas a cada 300 ms
let timerSalvar;
let gravando = Promise.resolve();
function salvar() {
  clearTimeout(timerSalvar);
  timerSalvar = setTimeout(() => {
    const copia = structuredClone(db);
    gravando = gravando
      .then(() => armazenamento.salvar(copia))
      .catch((err) => {
        console.error('Falha ao salvar, tentando de novo em 5s:', err.message);
        setTimeout(salvar, 5000);
      });
  }, 300);
}

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

// Fecha o dia: quem ainda esperava é cancelado, quem estava na cadeira conta como corte.
// Tudo vai para o histórico e as senhas recomeçam do Nº 1.
function fecharDia() {
  for (const c of db.fila) {
    if (c.status === 'aguardando' || c.status === 'chamado') {
      c.status = 'cancelado';
      c.finalizadoEm = c.finalizadoEm || Date.now();
    }
    if (c.status === 'atendendo') {
      c.status = 'concluido';
      c.finalizadoEm = Date.now();
      c.semDuracao = true; // fechado na virada: a duração não é real, fica fora do tempo médio
    }
    db.historico.push({ ...c, dia: db.diaAtual });
  }
  db.fila = [];
  db.contador = 0;
  db.diaAtual = diaDeTrabalho();
}

function virarDiaSePrecisar() {
  if (db.diaAtual === diaDeTrabalho()) return false;
  console.log(`  Novo dia de atendimento: ${diaDeTrabalho()} (fila de ${db.diaAtual} arquivada)`);
  // cópia de segurança de como tudo estava antes da virada
  armazenamento.backup(db.diaAtual, structuredClone(db)).catch((err) => console.error('Falha no backup:', err.message));
  fecharDia();
  return true;
}

setInterval(() => {
  if (!pronto) return;
  if (virarDiaSePrecisar()) return mudou();

  // Passou do tempo limite sem se apresentar: perde a vez e chama o próximo.
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
    // só durações plausíveis: ignora cliques acidentais (< 2 min) e cortes esquecidos abertos (> 3 h)
    .filter((c) => {
      const duracao = c.finalizadoEm - c.iniciadoEm;
      return c.status === 'concluido' && c.iniciadoEm && !c.semDuracao && duracao >= 2 * 60 * 1000 && duracao <= 3 * 60 * 60 * 1000;
    })
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

// Todos os clientes de um dia de trabalho (inclui o dia atual, mesmo se já foi encerrado uma vez)
function clientesDoDia(dia) {
  const doHistorico = db.historico.filter((c) => c.dia === dia);
  return dia === db.diaAtual ? doHistorico.concat(db.fila) : doHistorico;
}

// Resumo de cada dia da temporada, do mais recente para o mais antigo
function resumoDias() {
  const dias = [...new Set([...db.historico.map((c) => c.dia), db.diaAtual])].sort().reverse();
  return dias.map((dia) => {
    const lista = clientesDoDia(dia);
    return {
      dia,
      hoje: dia === db.diaAtual,
      cortes: lista.filter((c) => c.status === 'concluido').length,
      perderam: lista.filter((c) => c.status === 'expirado').length,
      senhas: lista.length,
    };
  });
}

function estatisticas() {
  const dias = resumoDias();
  const hoje = dias.find((d) => d.hoje);
  const manuaisHoje = clientesDoDia(db.diaAtual).filter((c) => c.status === 'concluido' && c.origem === 'manual').length;
  return {
    cortesHoje: hoje.cortes,
    cortesTotal: dias.reduce((s, d) => s + d.cortes, 0),
    diasTrabalhados: dias.filter((d) => d.senhas > 0).length,
    naFila: aguardando().length,
    perderamVez: hoje.perderam,
    manuaisHoje,
    mediaMs: mediaAtendimentoMs(),
    dias,
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
    dia: db.diaAtual,
    estado: db.config.estado,
    limiteMs: limiteMs(),
    limiteMinutos: db.config.limiteMinutos,
    mediaMs: mediaAtendimentoMs(),
    atual: a ? { numero: a.numero, nome: nomeCurto(a.nome), status: a.status, chamadoEm: a.chamadoEm } : null,
    fila: fila.map((c) => ({ numero: c.numero, nome: nomeCurto(c.nome) })),
    minha,
    // id informado mas não existe mais (ex.: Wagner encerrou o dia)
    senhaInvalida: Boolean(idCliente && !meu),
    recado: db.config.recado,
    vagas: vagasRestantes(),
  };
}

// Senhas que ainda podem ser tiradas hoje pelo celular (null = sem limite)
function vagasRestantes() {
  if (!db.config.limiteSenhas) return null;
  const usadas = db.fila.filter((c) => c.status !== 'cancelado').length;
  return Math.max(0, db.config.limiteSenhas - usadas);
}

function estadoAdmin() {
  const a = atual();
  return {
    agora: Date.now(),
    dia: db.diaAtual,
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
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // proxies (Render) não seguram as atualizações
  });
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
const pagina = (arquivo) => (req, res) => res.sendFile(path.join(__dirname, 'public', arquivo));
app.get('/admin', pagina('admin.html'));
app.get('/tv', pagina('tv.html'));
app.get('/cartaz', pagina('cartaz.html'));

app.get('/api/saude', (req, res) => res.json({ ok: true, armazenamento: armazenamento.descricao.split(' ')[0] }));

let portaAtual = PORT;

// Endereços na rede local (Wi‑Fi/cabo), ignorando adaptadores virtuais do Docker/WSL
function enderecosRede() {
  return Object.entries(os.networkInterfaces())
    .filter(([nome]) => !/vethernet|wsl|docker|virtualbox|vmware|hyper-v/i.test(nome))
    .flatMap(([, lista]) => lista)
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => `http://${i.address}:${portaAtual}`);
}

// Endereço que os clientes abrem: o da Render em produção, o IP do Wi‑Fi no computador
function urlPublica() {
  return process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || enderecosRede()[0] || `http://localhost:${portaAtual}`;
}

app.get('/api/link', (req, res) => res.json({ url: urlPublica() }));

// QR Code com o link da fila (para o cartaz e a TV)
app.get('/api/qr.svg', async (req, res) => {
  const svg = await QRCode.toString(urlPublica(), { type: 'svg', margin: 1, color: { dark: '#1c1a17', light: '#ffffff' } });
  res.type('image/svg+xml').send(svg);
});

app.get('/api/stream', (req, res) => abrirStream(req, res, { id: String(req.query.id || '') || null }));

app.post('/api/entrar', (req, res) => {
  if (db.config.estado === 'fechado') return res.status(400).json({ erro: 'A fila está fechada no momento.' });
  if (vagasRestantes() === 0) return res.status(400).json({ erro: 'As senhas de hoje acabaram. Fale com o Wagner.' });
  const dados = lerCliente(req.body, 'cliente');
  if (dados.erro) return res.status(400).json(dados);
  const repetido = db.fila.find((c) => c.telefone === dados.telefone && ['aguardando', 'chamado', 'atendendo'].includes(c.status));
  if (repetido) return res.status(400).json({ erro: `Esse WhatsApp já está na fila com a senha Nº ${repetido.numero}.` });
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

app.get('/api/admin/info', autenticado, (req, res) => {
  res.json({ enderecos: [urlPublica()] });
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
  const limiteSenhas = Number(req.body.limiteSenhas) || 0;
  if (!(limiteSenhas >= 0 && limiteSenhas <= 500)) return res.status(400).json({ erro: 'Limite de senhas entre 0 e 500.' });
  db.config.limiteMinutos = limite;
  db.config.mensagem = mensagem;
  db.config.recado = String(req.body.recado || '').trim().slice(0, 200);
  db.config.limiteSenhas = Math.floor(limiteSenhas);
  mudou();
  res.json({ ok: true });
});

// Apaga de vez um registro (ex.: cortes de teste). Só quem já saiu da fila.
app.post('/api/admin/apagar', autenticado, (req, res) => {
  const id = String(req.body.id || '');
  const naFila = db.fila.find((c) => c.id === id);
  if (naFila && !['concluido', 'expirado', 'cancelado'].includes(naFila.status)) {
    return res.status(400).json({ erro: 'Esse cliente ainda está na fila. Use Remover ou Pular.' });
  }
  const antes = db.fila.length + db.historico.length;
  db.fila = db.fila.filter((c) => c.id !== id);
  db.historico = db.historico.filter((c) => c.id !== id);
  if (db.fila.length + db.historico.length === antes) return res.status(404).json({ erro: 'Registro não encontrado.' });
  mudou();
  res.json({ ok: true });
});

// Planilha com todos os atendimentos da temporada (abre no Excel)
app.get('/api/admin/exportar', autenticado, (req, res) => {
  const nomesStatus = { concluido: 'cortou', expirado: 'perdeu a vez', cancelado: 'saiu', aguardando: 'na fila', chamado: 'chamado', atendendo: 'na cadeira' };
  const hora = (ms) => (ms ? new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '');
  const campo = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const linhas = [['Dia', 'Senha', 'Nome', 'Telefone', 'Situação', 'Cadastro', 'Chegou na fila', 'Começou', 'Terminou']];
  const todos = db.historico.concat(db.fila.map((c) => ({ ...c, dia: db.diaAtual })));
  todos.sort((a, b) => a.dia.localeCompare(b.dia) || a.numero - b.numero);
  for (const c of todos) {
    linhas.push([c.dia.split('-').reverse().join('/'), c.numero, c.nome, c.telefone, nomesStatus[c.status] || c.status,
      c.origem === 'manual' ? 'pelo Wagner' : 'pelo celular', hora(c.criadoEm), hora(c.iniciadoEm), hora(c.finalizadoEm)]);
  }
  const csv = '﻿' + linhas.map((l) => l.map(campo).join(';')).join('\r\n');
  res.set('Content-Disposition', `attachment; filename="cortes-barbearia-wagner.csv"`);
  res.type('text/csv; charset=utf-8').send(csv);
});

// Encerrar antes da hora (o dia também vira sozinho às 4h)
app.post('/api/admin/encerrar-dia', autenticado, (req, res) => {
  fecharDia();
  mudou();
  res.json({ ok: true });
});

// Quem passou pela fila num dia específico
app.get('/api/admin/dia/:dia', autenticado, (req, res) => {
  const lista = clientesDoDia(String(req.params.dia))
    .sort((a, b) => a.numero - b.numero || a.criadoEm - b.criadoEm)
    .map(({ id, numero, nome, telefone, status, origem, criadoEm, iniciadoEm, finalizadoEm }) => ({
      id, numero, nome, telefone, status, origem, criadoEm, iniciadoEm, finalizadoEm,
    }));
  res.json({ clientes: lista });
});

// Se a porta estiver ocupada (ex.: Docker), tenta a próxima livre
function iniciar(porta, tentativas = 10) {
  const servidor = app.listen(porta, () => {
    portaAtual = porta;
    console.log(`\n  Barbearia do Wagner — fila rodando`);
    console.log(`  Dados:    ${armazenamento.descricao}`);
    console.log(`  Clientes: ${urlPublica()}`);
    console.log(`  Wagner:   ${urlPublica()}/admin  (senha: ${process.env.ADMIN_SENHA ? '[definida em ADMIN_SENHA]' : SENHA_ADMIN})\n`);
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

carregarDados()
  .then(() => {
    virarDiaSePrecisar();
    pronto = true;
    salvar();
    iniciar(PORT);
  })
  .catch((err) => {
    // Não sobe com a fila vazia: isso sobrescreveria os dados salvos
    console.error('Não foi possível carregar os dados. O servidor não vai iniciar para não apagar nada.');
    console.error(err);
    process.exit(1);
  });
