// Onde os dados ficam guardados: um banco SQLite (arquivo barbearia.db) dentro de DATA_DIR.
//  - No computador: ./data/barbearia.db
//  - Na Render: no Persistent Disk (DATA_DIR=/var/data), que não é apagado nos deploys.
// Os dados são um único documento JSON (fila do dia + histórico + configurações),
// guardado na tabela "barbearia"; as cópias de segurança ficam na mesma tabela.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

module.exports = function criarArmazenamento({ pasta }) {
  fs.mkdirSync(pasta, { recursive: true });
  const arquivo = path.join(pasta, 'barbearia.db');
  const banco = new DatabaseSync(arquivo);
  banco.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS barbearia (
      chave TEXT PRIMARY KEY,
      dados TEXT NOT NULL,
      atualizado TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const ler = banco.prepare('SELECT dados FROM barbearia WHERE chave = ?');
  const gravar = banco.prepare(`
    INSERT INTO barbearia (chave, dados, atualizado) VALUES (?, ?, datetime('now'))
    ON CONFLICT (chave) DO UPDATE SET dados = excluded.dados, atualizado = excluded.atualizado
  `);

  return {
    descricao: `SQLite ${arquivo}`,
    async carregar() {
      const linha = ler.get('principal');
      // Linha existe mas o JSON está corrompido: JSON.parse dá erro e o servidor não sobe (não sobrescreve nada)
      return linha ? JSON.parse(linha.dados) : null;
    },
    async salvar(dados) {
      gravar.run('principal', JSON.stringify(dados));
    },
    async backup(nome, dados) {
      gravar.run(`backup-${nome}`, JSON.stringify(dados));
    },
  };
};
