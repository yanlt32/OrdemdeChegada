const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pad = (n) => String(n).padStart(2, '0');

let estado = null;
let offset = 0; // diferença entre o relógio do servidor e o do celular
let fonte = null;
let ultimoStatus = null;
let eraProximo = false;

const meuId = () => localStorage.getItem('senhaId');

function conectar() {
  if (fonte) fonte.close();
  const id = meuId();
  fonte = new EventSource('/api/stream' + (id ? `?id=${encodeURIComponent(id)}` : ''));
  fonte.onmessage = (e) => {
    estado = JSON.parse(e.data);
    offset = estado.agora - Date.now();
    if (estado.senhaInvalida) {
      localStorage.removeItem('senhaId');
      return conectar();
    }
    render();
  };
  fonte.onerror = () => { $('agora-texto').textContent = 'Reconectando…'; };
}

function formatarEspera(ms) {
  const min = Math.max(1, Math.round(ms / 60000));
  if (min < 60) return `~${min} min`;
  return `~${Math.floor(min / 60)}h${pad(min % 60)}`;
}

function render() {
  const s = estado;
  const limiteMin = Math.round(s.limiteMs / 60000);
  const [a, mes, d] = s.dia.split('-').map(Number);
  $('data-hoje').textContent = `Fila de ${new Date(a, mes - 1, d).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })}`;

  // Faixa "agora"
  let agora;
  if (s.atual) {
    const verbo = s.atual.status === 'chamado' ? 'Chamando' : 'Na cadeira';
    agora = `${verbo}: <strong class="num">Nº ${s.atual.numero}</strong> · ${esc(s.atual.nome)}`;
  } else if (s.estado === 'pausado') agora = '<span class="dot pausado"></span>Wagner em pausa, já volta';
  else if (s.estado === 'fechado') agora = '<span class="dot fechado"></span>Fila fechada';
  else agora = '<span class="dot aberto"></span>Cadeira livre';
  $('agora-texto').innerHTML = agora;
  $('agora-fila').textContent = `${s.fila.length} ${s.fila.length === 1 ? 'esperando' : 'esperando'}`;

  $('recado').hidden = !s.recado;
  $('recado').textContent = s.recado || '';

  // Qual tela mostrar
  const temSenha = Boolean(s.minha);
  const esgotado = s.vagas === 0;
  const semCadastro = s.estado === 'fechado' || esgotado;
  $('tela-senha').hidden = !temSenha;
  $('tela-cadastro').hidden = temSenha || semCadastro;
  $('tela-fechada').hidden = temSenha || !semCadastro;
  if (esgotado && s.estado !== 'fechado') {
    $('fechada-titulo').textContent = 'Senhas esgotadas';
    $('fechada-texto').textContent = 'As senhas de hoje acabaram. Fale com o Wagner pessoalmente ou volte amanhã.';
  } else {
    $('fechada-titulo').textContent = 'Fila fechada';
    $('fechada-texto').textContent = 'O Wagner não está recebendo novos clientes agora. Volte mais tarde ou fale com ele pessoalmente.';
  }
  $('vagas').hidden = s.vagas === null || s.vagas > 10;
  $('vagas').innerHTML = s.vagas === 1 ? 'Resta <b>1 senha</b> hoje' : `Restam <b>${s.vagas} senhas</b> hoje`;
  document.querySelectorAll('.tol-min').forEach((el) => (el.textContent = limiteMin));

  if (temSenha) renderSenha(s.minha, s, limiteMin);
  renderFila(s);
}

function renderSenha(m, s, limiteMin) {
  const ticket = $('ticket');
  ticket.className = `ticket ${m.status}`;
  $('t-numero').textContent = `Nº ${m.numero}`;
  $('t-nome').textContent = m.nome;
  // destaque da tolerância enquanto ainda espera (quando é chamado, a contagem já ocupa esse papel)
  $('tolerancia-senha').hidden = m.status !== 'aguardando';
  const primeiroNome = esc(m.nome.split(' ')[0]);
  const novaSenha = '<div class="ticket-acoes"><button class="btn btn-block" onclick="novaSenha()">Pegar nova senha</button></div>';
  let html = '';

  switch (m.status) {
    case 'aguardando': {
      let texto = 'Pode ficar tranquilo, esta tela atualiza sozinha.';
      if (m.proximo) texto = `Fique por perto! Assim que o corte atual terminar, você será chamado e terá tolerância de ${limiteMin} minutos para se apresentar.`;
      if (s.estado === 'pausado') texto = 'O Wagner está em pausa. A fila volta a andar em breve.';
      html = `
        <h2>${m.proximo ? 'Você é o próximo!' : 'Você está na fila'}</h2>
        ${m.proximo ? `<div class="aviso">${esc(texto)}</div>` : `<p>${texto}</p>`}
        <div class="metricas">
          <div><b class="num">${m.aFrente}</b><span>${m.aFrente === 1 ? 'pessoa' : 'pessoas'} na sua frente</span></div>
          <div><b class="num">${m.aFrente === 0 ? 'agora' : formatarEspera(m.aFrente * s.mediaMs)}</b><span>espera estimada</span></div>
        </div>
        <div class="ticket-acoes"><button class="link-sair" onclick="sair()">Sair da fila</button></div>`;
      break;
    }
    case 'chamado':
      html = `
        <h2>É a sua vez de cortar!</h2>
        <div class="aviso">${esc(m.mensagem)}</div>
        <p>Sua tolerância de <strong>${limiteMin} minutos</strong> termina em:</p>
        <div class="contagem num" id="contagem">--:--</div>
        <div class="barra"><i id="barra"></i></div>
        <div class="ticket-acoes"><button class="link-sair" onclick="sair()">Desistir da vez</button></div>`;
      break;
    case 'atendendo':
      html = '<h2>Você está na cadeira</h2><p>Bom corte!</p>';
      break;
    case 'concluido':
      html = `<h2>Valeu, ${primeiroNome}!</h2><p>Corte finalizado. Até a próxima.</p>${novaSenha}`;
      break;
    case 'expirado':
      html = `<h2>Você perdeu a vez</h2><p>Os ${limiteMin} minutos passaram e a fila andou. Fale com o Wagner: ele pode te colocar de volta no fim da fila.</p>${novaSenha}`;
      break;
    default:
      html = `<h2>Você saiu da fila</h2><p>Sua senha foi cancelada.</p>${novaSenha}`;
  }
  $('t-status').innerHTML = html;

  if (m.status === 'chamado' && ultimoStatus !== 'chamado') avisar();
  const agoraProximo = m.status === 'aguardando' && m.proximo;
  if (agoraProximo && !eraProximo) try { navigator.vibrate && navigator.vibrate(300); } catch {}
  eraProximo = agoraProximo;
  ultimoStatus = m.status;
  tick();
}

function renderFila(s) {
  const id = s.minha && s.minha.status === 'aguardando' ? s.minha.numero : null;
  $('fila-total').textContent = s.fila.length ? `${s.fila.length} ${s.fila.length === 1 ? 'pessoa' : 'pessoas'}` : '';
  $('lista').innerHTML = s.fila.length
    ? s.fila.map((c, i) => `
        <li class="${c.numero === id ? 'eu' : ''}">
          <span class="pos num">${i + 1}º</span>
          <span class="senha num">${c.numero}</span>
          <span class="nome">${esc(c.nome)}${c.numero === id ? ' (você)' : ''}</span>
        </li>`).join('')
    : '<li class="vazio">Ninguém esperando.</li>';
}

// Contagem regressiva dos 5 minutos
function tick() {
  if (!estado || !estado.minha || estado.minha.status !== 'chamado') return;
  const restante = Math.max(0, estado.minha.chamadoEm + estado.limiteMs - (Date.now() + offset));
  const el = $('contagem');
  if (el) el.textContent = `${pad(Math.floor(restante / 60000))}:${pad(Math.floor(restante / 1000) % 60)}`;
  const barra = $('barra');
  if (barra) barra.style.width = `${(restante / estado.limiteMs) * 100}%`;
}
setInterval(tick, 250);

// Som + vibração quando chega a vez
function avisar() {
  try { navigator.vibrate && navigator.vibrate([300, 150, 300, 150, 600]); } catch {}
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.25, 0.5].forEach((t, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = i === 2 ? 1046 : 784;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.22);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + t);
      o.stop(ctx.currentTime + t + 0.25);
    });
  } catch {}
  document.title = '(!) Sua vez · Barbearia do Wagner';
  setTimeout(() => { document.title = 'Fila · Barbearia do Wagner'; }, 15000);
}

$('form-entrar').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('btn-entrar');
  btn.disabled = true;
  $('erro-entrar').textContent = '';
  try {
    const r = await fetch('/api/entrar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nome: $('nome').value, telefone: $('telefone').value }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.erro);
    localStorage.setItem('senhaId', d.id);
    localStorage.setItem('ultimoNome', $('nome').value.trim());
    localStorage.setItem('ultimoTelefone', $('telefone').value);
    ultimoStatus = null;
    conectar();
  } catch (err) {
    $('erro-entrar').textContent = err.message || 'Não foi possível entrar na fila.';
  } finally {
    btn.disabled = false;
  }
});

async function sair() {
  if (!confirm('Tem certeza que quer sair da fila? Você perde sua posição.')) return;
  await fetch('/api/sair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: meuId() }) });
}

function novaSenha() {
  localStorage.removeItem('senhaId');
  ultimoStatus = null;
  conectar();
}

// Celular com a tela apagada pode pausar a conexão: ao voltar para a página, reconecta e atualiza na hora
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') conectar();
});

// Máscara do WhatsApp: (11) 98765-4321
function mascaraTelefone(valor) {
  const d = valor.replace(/\D/g, '').slice(0, 11);
  if (d.length <= 2) return d.length ? `(${d}` : '';
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}
$('telefone').addEventListener('input', (e) => { e.target.value = mascaraTelefone(e.target.value); });

$('nome').value = localStorage.getItem('ultimoNome') || '';
$('telefone').value = localStorage.getItem('ultimoTelefone') || '';
conectar();
