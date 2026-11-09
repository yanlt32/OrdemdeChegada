const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pad = (n) => String(n).padStart(2, '0');
const hora = (ms) => new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

let token = localStorage.getItem('adminToken');
let estado = null;
let offset = 0;
let fonte = null;

// ---------- Login ----------

function mostrar(logado) {
  $('tela-login').hidden = logado;
  $('tela-painel').hidden = !logado;
}

$('form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('erro-login').textContent = '';
  const r = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: $('senha').value }),
  });
  const d = await r.json();
  if (!r.ok) return ($('erro-login').textContent = d.erro);
  token = d.token;
  localStorage.setItem('adminToken', token);
  iniciar();
});

function sairDoPainel() {
  localStorage.removeItem('adminToken');
  token = null;
  if (fonte) fonte.close();
  mostrar(false);
}
$('btn-sair').addEventListener('click', sairDoPainel);

async function api(caminho, corpo) {
  const r = await fetch('/api/admin/' + caminho, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-token': token },
    body: JSON.stringify(corpo || {}),
  });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401) sairDoPainel();
  if (!r.ok) throw new Error(d.erro || 'Algo deu errado.');
  return d;
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
}

async function acao(id, nomeAcao) {
  try {
    await api('acao', { id, acao: nomeAcao });
  } catch (err) {
    toast(err.message);
  }
}

// X: apaga o registro de vez (cortes de teste, cadastro errado)
async function apagar(id, nome, dia) {
  if (!confirm(`Apagar ${nome} de vez?\n\nO registro some da lista e da contagem de cortes. Não dá para desfazer.`)) return;
  try {
    await api('apagar', { id });
    toast(`${nome} apagado`);
    if (dia) carregarDia(dia);
  } catch (err) {
    toast(err.message);
  }
}

const botaoApagar = (c, dia = '') =>
  `<button class="btn-x" title="Apagar de vez" aria-label="Apagar ${esc(c.nome)}" onclick="apagar('${c.id}','${esc(c.nome).replace(/'/g, '')}','${dia}')">×</button>`;

$('baixar-planilha').addEventListener('click', (e) => {
  e.preventDefault();
  location.href = `/api/admin/exportar?token=${encodeURIComponent(token)}`;
});

// ---------- Tempo real ----------

async function iniciar() {
  mostrar(true);
  const teste = await fetch('/api/admin/info', { headers: { 'x-token': token || '' } });
  if (!teste.ok) return sairDoPainel();
  const { enderecos } = await teste.json();
  const url = enderecos[0] || location.origin;
  $('link-clientes').innerHTML = `Clientes acessam: <code>${esc(url)}</code>`;

  if (fonte) fonte.close();
  fonte = new EventSource(`/api/admin/stream?token=${encodeURIComponent(token)}`);
  fonte.onmessage = (e) => {
    estado = JSON.parse(e.data);
    offset = estado.agora - Date.now();
    render();
  };
}

function formatarDuracao(ms) {
  const min = Math.round(ms / 60000);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)}h${pad(min % 60)}`;
}

function render() {
  const s = estado;
  const st = s.stats;

  document.querySelectorAll('#estado button').forEach((b) => b.classList.toggle('ativo', b.dataset.estado === s.config.estado));
  $('data-hoje').textContent = dataPorExtenso(s.dia);

  $('k-hoje').textContent = st.cortesHoje;
  $('k-manuais').textContent = st.manuaisHoje ? `${st.manuaisHoje} cadastrados por você` : '';
  $('k-total').textContent = st.cortesTotal;
  $('k-dias').textContent = `em ${st.diasTrabalhados} ${st.diasTrabalhados === 1 ? 'dia' : 'dias'}`;
  $('k-fila').textContent = st.naFila;
  $('k-espera').textContent = st.naFila ? `~${formatarDuracao(st.naFila * st.mediaMs)} de espera` : 'ninguém esperando';
  $('k-perderam').textContent = st.perderamVez;
  $('k-media').textContent = formatarDuracao(st.mediaMs);

  renderCadeira(s);
  renderFila(s);
  renderEncerrados(s);
  renderPorDia(st);
}

function renderCadeira(s) {
  const el = $('cadeira');
  const a = s.atual;
  el.className = `card cadeira ${a ? a.status : ''}`;

  if (!a) {
    const proximo = s.fila[0];
    const msg = s.config.estado === 'aberto'
      ? 'Assim que alguém entrar na fila, ele é chamado automaticamente.'
      : s.config.estado === 'pausado'
        ? 'Fila em pausa. Ninguém é chamado até você abrir de novo.'
        : 'Fila fechada para novos clientes.';
    el.innerHTML = `
      <div class="cadeira-livre">
        <h3>Cadeira livre</h3>
        <p>${msg}</p>
        ${proximo ? `<button class="btn btn-primary" onclick="acao('${proximo.id}','chamar')">Chamar Nº ${proximo.numero} · ${esc(proximo.nome)}</button>` : ''}
      </div>`;
    return;
  }

  const chamado = a.status === 'chamado';
  const numeroZap = a.telefone ? `${a.telefone.length <= 11 ? '55' : ''}${a.telefone}` : '';
  const zap = numeroZap && !chamado ? `<a href="https://wa.me/${numeroZap}" target="_blank" rel="noopener">WhatsApp</a>` : '';
  const avisar = numeroZap && chamado
    ? `<a class="btn btn-zap" href="https://wa.me/${numeroZap}?text=${encodeURIComponent(a.mensagem)}" target="_blank" rel="noopener">Avisar no WhatsApp</a>`
    : '';
  const origem = a.origem === 'manual' ? '<span class="tag">sem celular</span>' : '';
  const proximo = s.fila[0];
  // "Chamar próximo" já conta o corte de quem está na cadeira
  const botaoProximo = proximo
    ? `<button class="btn btn-primary" onclick="acao('${a.id}','proximo')">Chamar próximo · Nº ${proximo.numero}</button>`
    : `<button class="btn btn-primary" onclick="acao('${a.id}','proximo')">Liberar cadeira</button>`;
  const dica = proximo
    ? `O corte de ${esc(a.nome.split(' ')[0])} entra na conta e ${esc(proximo.nome.split(' ')[0])} é chamado.`
    : 'Ninguém esperando. O corte entra na conta e a cadeira fica livre.';

  el.innerHTML = `
    <div class="card-title">
      <span>${chamado ? 'Chamando' : 'Na cadeira'}</span>
      <span class="tag ${chamado ? 'tag-brass' : 'tag-green'}">${chamado ? 'esperando chegar' : 'cortando'}</span>
    </div>
    <div class="cadeira-corpo">
      <div>
        <div class="cadeira-numero num">Nº ${a.numero}</div>
        <div class="cadeira-nome">${esc(a.nome)}</div>
        <div class="cadeira-info">${a.telefone ? `<span class="num">${formatarTelefone(a.telefone)}</span>` : ''}${origem}${zap}</div>
      </div>
      <div class="cadeira-tempo" id="cadeira-tempo">
        <b class="num" id="relogio">--:--</b>
        <span>${chamado ? 'para se apresentar' : 'de corte'}</span>
      </div>
    </div>
    ${chamado ? `<div class="aviso">${esc(a.mensagem)}</div>` : ''}
    <div class="cadeira-acoes">
      ${chamado
        ? `<button class="btn btn-primary" onclick="acao('${a.id}','chegou')">Chegou · começar corte</button>
           ${avisar}
           <button class="btn btn-ghost-red" onclick="acao('${a.id}','pular')">Pular</button>`
        : botaoProximo}
    </div>
    ${chamado ? '' : `<p class="cadeira-dica">${dica}</p>`}`;
  tick();
}

function renderFila(s) {
  const livre = !s.atual;
  $('fila-total').textContent = s.fila.length ? `${s.fila.length} ${s.fila.length === 1 ? 'pessoa' : 'pessoas'}` : '';
  $('lista-fila').innerHTML = s.fila.length
    ? s.fila.map((c, i) => `
        <li>
          <span class="pos num">${i + 1}º</span>
          <span class="senha num">${c.numero}</span>
          <span class="nome">${esc(c.nome)}<br><span class="meta">chegou ${hora(c.criadoEm)}${c.telefone ? ' · ' + formatarTelefone(c.telefone) : ''}${c.origem === 'manual' ? ' · cadastrado por você' : ''}</span></span>
          <span class="acoes">
            ${livre ? `<button class="btn btn-sm" onclick="acao('${c.id}','chamar')">Chamar</button>` : ''}
            <button class="btn btn-sm btn-ghost-red" onclick="remover('${c.id}','${esc(c.nome).replace(/'/g, '')}')">Remover</button>
          </span>
        </li>`).join('')
    : '<li class="vazio">Ninguém esperando.</li>';
}

function renderEncerrados(s) {
  const rotulo = {
    concluido: '<span class="tag tag-green">cortou</span>',
    expirado: '<span class="tag tag-red">perdeu a vez</span>',
    cancelado: '<span class="tag">saiu</span>',
  };
  $('lista-encerrados').innerHTML = s.encerrados.length
    ? s.encerrados.map((c) => `
        <li>
          <span class="senha num">${c.numero}</span>
          <span class="nome">${esc(c.nome)}<br><span class="meta">${c.finalizadoEm ? hora(c.finalizadoEm) : ''}</span></span>
          ${rotulo[c.status]}
          ${c.status !== 'concluido' ? `<button class="btn btn-sm" onclick="acao('${c.id}','reinserir')" title="Coloca de volta no fim da fila">Voltar à fila</button>` : ''}
          ${botaoApagar(c)}
        </li>`).join('')
    : '<li class="vazio">Nada por aqui ainda.</li>';
}

// ---------- Dias de atendimento ----------

const paraData = (dia) => { const [a, m, d] = dia.split('-').map(Number); return new Date(a, m - 1, d); };

function dataPorExtenso(dia) {
  const t = paraData(dia).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
  return t.charAt(0).toUpperCase() + t.slice(1);
}

const diasAbertos = new Set(); // dias expandidos (sobrevivem às atualizações em tempo real)
const listasDosDias = new Map(); // conteúdo já carregado de cada dia

function renderPorDia(st) {
  const max = Math.max(1, ...st.dias.map((d) => d.cortes));
  $('por-dia').innerHTML = st.dias.map((d) => {
    const rotulo = d.hoje ? 'Hoje' : paraData(d.dia).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });
    const extra = d.perderam ? `${d.perderam} ${d.perderam === 1 ? 'perdeu' : 'perderam'} a vez` : '';
    return `
    <details class="dia${d.hoje ? ' hoje' : ''}" data-dia="${d.dia}" ${diasAbertos.has(d.dia) ? 'open' : ''}>
      <summary class="barra-corte">
        <span class="dia-rotulo">${rotulo}</span>
        <span class="trilho"><i style="width:${(d.cortes / max) * 100}%"></i></span>
        <span class="valores num"><b>${d.cortes}</b> ${d.cortes === 1 ? 'corte' : 'cortes'}</span>
        ${extra ? `<span class="dia-extra">${extra}</span>` : ''}
      </summary>
      <div class="dia-lista" id="lista-${d.dia}">${listasDosDias.get(d.dia) || '<p class="vazio">Carregando…</p>'}</div>
    </details>`;
  }).join('');
  // dias abertos: recarrega (o de hoje muda o tempo todo)
  for (const dia of diasAbertos) carregarDia(dia);
}

async function carregarDia(dia) {
  const r = await fetch(`/api/admin/dia/${dia}`, { headers: { 'x-token': token } });
  if (!r.ok) return;
  const { clientes } = await r.json();
  const rotulo = {
    concluido: '<span class="tag tag-green">cortou</span>',
    expirado: '<span class="tag tag-red">perdeu a vez</span>',
    cancelado: '<span class="tag">saiu</span>',
    aguardando: '<span class="tag">na fila</span>',
    chamado: '<span class="tag tag-brass">chamado</span>',
    atendendo: '<span class="tag tag-green">na cadeira</span>',
  };
  const html = clientes.length
    ? `<ul class="lista">${clientes.map((c) => `
        <li>
          <span class="senha num">${c.numero}</span>
          <span class="nome">${esc(c.nome)}<br><span class="meta">chegou ${hora(c.criadoEm)}${c.telefone ? ' · ' + formatarTelefone(c.telefone) : ''}</span></span>
          ${rotulo[c.status] || ''}
          ${['concluido', 'expirado', 'cancelado'].includes(c.status) ? botaoApagar(c, dia) : '<span class="btn-x-vazio"></span>'}
        </li>`).join('')}</ul>`
    : '<p class="vazio">Ninguém passou pela fila neste dia.</p>';
  listasDosDias.set(dia, html);
  const el = document.getElementById(`lista-${dia}`);
  if (el) el.innerHTML = html;
}

// "toggle" não borbulha: escuta na fase de captura
$('por-dia').addEventListener('toggle', (e) => {
  const dia = e.target.dataset && e.target.dataset.dia;
  if (!dia) return;
  if (e.target.open) {
    diasAbertos.add(dia);
    carregarDia(dia);
  } else {
    diasAbertos.delete(dia);
  }
}, true);

// Máscara do telefone no cadastro manual: (11) 98765-4321
$('a-tel').addEventListener('input', (e) => {
  const d = e.target.value.replace(/\D/g, '').slice(0, 11);
  e.target.value = d.length > 2 ? formatarTelefone(d) : d;
});

function formatarTelefone(t) {
  if (t.length <= 6) return `(${t.slice(0, 2)}) ${t.slice(2)}`;
  return t.length === 11 ? `(${t.slice(0, 2)}) ${t.slice(2, 7)}-${t.slice(7)}` : `(${t.slice(0, 2)}) ${t.slice(2, 6)}-${t.slice(6)}`;
}

// Relógio da cadeira: contagem regressiva quando chamado, cronômetro quando cortando
function tick() {
  if (!estado || !estado.atual) return;
  const el = $('relogio');
  if (!el) return;
  const agora = Date.now() + offset;
  const a = estado.atual;
  let ms;
  if (a.status === 'chamado') {
    ms = Math.max(0, a.chamadoEm + estado.limiteMs - agora);
    $('cadeira-tempo').classList.toggle('urgente', ms < 60000);
  } else {
    ms = agora - a.iniciadoEm;
  }
  el.textContent = `${pad(Math.floor(ms / 60000))}:${pad(Math.floor(ms / 1000) % 60)}`;
}
setInterval(tick, 250);

// ---------- Ações ----------

function remover(id, nome) {
  if (confirm(`Remover ${nome} da fila?`)) acao(id, 'remover');
}

document.querySelectorAll('#estado button').forEach((b) =>
  b.addEventListener('click', () => api('estado', { estado: b.dataset.estado }).catch((e) => toast(e.message))),
);

$('form-adicionar').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('erro-adicionar').textContent = '';
  try {
    const d = await api('adicionar', { nome: $('a-nome').value, telefone: $('a-tel').value });
    toast(`Senha Nº ${d.numero} para ${$('a-nome').value.trim()}`);
    $('a-nome').value = '';
    $('a-tel').value = '';
    $('a-nome').focus();
  } catch (err) {
    $('erro-adicionar').textContent = err.message;
  }
});

// Preenche as configurações só ao abrir, para não apagar o que está sendo digitado
document.querySelector('details.config').addEventListener('toggle', (e) => {
  if (!e.target.open || !estado) return;
  $('c-limite').value = estado.config.limiteMinutos;
  $('c-mensagem').value = estado.config.mensagem;
  $('c-recado').value = estado.config.recado || '';
  $('c-senhas').value = estado.config.limiteSenhas || '';
});

$('form-config').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('erro-config').textContent = '';
  try {
    await api('config', {
      limiteMinutos: Number($('c-limite').value),
      mensagem: $('c-mensagem').value,
      recado: $('c-recado').value,
      limiteSenhas: Number($('c-senhas').value) || 0,
    });
    toast('Configurações salvas');
  } catch (err) {
    $('erro-config').textContent = err.message;
  }
});

$('btn-encerrar').addEventListener('click', async () => {
  if (!confirm('Encerrar o dia agora? A fila é zerada e as senhas voltam para o Nº 1. Os cortes ficam guardados no dia de hoje.\n\n(O dia já vira sozinho às 4h da manhã.)')) return;
  try {
    await api('encerrar-dia');
    toast('Dia encerrado');
  } catch (err) {
    toast(err.message);
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && token) iniciar();
});

if (token) iniciar();
else mostrar(false);
