// Onde os dados ficam guardados.
//  - DATABASE_URL definida (produção/Render): Postgres. Deploys não apagam nada, o banco fica fora do servidor.
//  - Senão: arquivo JSON em DATA_DIR (padrão ./data), bom para rodar no computador.
// Os dados são um único documento JSON (fila do dia + histórico + configurações).

const fs = require('fs');
const path = require('path');

function armazenamentoArquivo(pasta) {
  const arquivo = path.join(pasta, 'dados.json');

  function gravar(destino, dados) {
    fs.mkdirSync(pasta, { recursive: true });
    const conteudo = JSON.stringify(dados, null, 2);
    const tmp = destino + '.tmp';
    try {
      fs.writeFileSync(tmp, conteudo);
      fs.renameSync(tmp, destino);
    } catch {
      fs.writeFileSync(destino, conteudo); // OneDrive às vezes bloqueia o rename
    }
  }

  return {
    descricao: `arquivo ${arquivo}`,
    async carregar() {
      let texto;
      try {
        texto = fs.readFileSync(arquivo, 'utf8');
      } catch (err) {
        if (err.code === 'ENOENT') return null; // primeira vez: começa do zero
        throw err;
      }
      // Arquivo existe mas está corrompido: para tudo em vez de começar vazio e sobrescrever
      return JSON.parse(texto.replace(/^﻿/, ''));
    },
    async salvar(dados) {
      gravar(arquivo, dados);
    },
    async backup(nome, dados) {
      gravar(path.join(pasta, `backup-${nome}.json`), dados);
    },
  };
}

function armazenamentoPostgres(url) {
  const { Pool } = require('pg');
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const pool = new Pool({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false }, max: 3 });
  let tabelaPronta;

  const preparar = () =>
    (tabelaPronta ??= pool.query(`
      CREATE TABLE IF NOT EXISTS barbearia (
        chave text PRIMARY KEY,
        dados jsonb NOT NULL,
        atualizado timestamptz NOT NULL DEFAULT now()
      )`));

  async function gravar(chave, dados) {
    await preparar();
    await pool.query(
      `INSERT INTO barbearia (chave, dados, atualizado) VALUES ($1, $2, now())
       ON CONFLICT (chave) DO UPDATE SET dados = EXCLUDED.dados, atualizado = now()`,
      [chave, JSON.stringify(dados)],
    );
  }

  return {
    descricao: 'Postgres (DATABASE_URL)',
    async carregar() {
      await preparar();
      const { rows } = await pool.query("SELECT dados FROM barbearia WHERE chave = 'principal'");
      return rows.length ? rows[0].dados : null;
    },
    salvar: (dados) => gravar('principal', dados),
    backup: (nome, dados) => gravar(`backup-${nome}`, dados),
  };
}

module.exports = function criarArmazenamento({ databaseUrl, pasta }) {
  return databaseUrl ? armazenamentoPostgres(databaseUrl) : armazenamentoArquivo(pasta);
};
