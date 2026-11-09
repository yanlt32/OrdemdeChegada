# Fila da Barbearia do Wagner

Sistema simples de fila por ordem de chegada para a temporada de fim de ano. O cliente pega a senha pelo celular e acompanha sua posição em tempo real; o Wagner controla tudo por um painel.

| Página | Endereço | Para quem |
| --- | --- | --- |
| Fila | `/` | Clientes (pelo celular) |
| Painel | `/admin` | Wagner (com senha) |
| Tela para TV | `/tv` | TV ou tablet na barbearia: quem está sendo chamado e os próximos |
| Cartaz | `/cartaz` | Folha A4 com QR Code para imprimir e colar no espelho |

## Colocar no ar (Render)

Os dados ficam num **Postgres fora do servidor**. Assim **nenhum deploy apaga a fila nem o histórico**. Se o banco não estiver configurado, o servidor se recusa a subir em vez de começar vazio.

### 1. Criar o banco (Neon, grátis)

1. Crie uma conta em [neon.tech](https://neon.tech) e um projeto (região **São Paulo**, se tiver).
2. Copie a **connection string**. Ela começa com `postgresql://` e termina com `?sslmode=require`.

> O Postgres grátis da própria Render **expira em 30 dias**. Por isso o Neon, que não expira.

### 2. Criar o serviço na Render

1. Suba este código no GitHub.
2. Na Render: **New → Blueprint** e escolha este repositório. O arquivo `render.yaml` já tem tudo configurado.
3. A Render vai pedir duas variáveis:
   - `ADMIN_SENHA`: a senha do painel do Wagner.
   - `DATABASE_URL`: a connection string do Neon.
4. Pronto. O endereço fica algo como `https://fila-barbearia-wagner.onrender.com`. Abra `/cartaz` e imprima o QR Code.

**Plano:** o `render.yaml` usa o **Starter**. O plano **Free** funciona, mas "dorme" depois de 15 minutos sem acesso e leva cerca de 1 minuto para acordar. Para trocar, mude `plan: starter` para `plan: free`.

### Backups

- Antes de cada virada de dia, uma cópia de tudo é salva no banco (linha `backup-AAAA-MM-DD`).
- No painel, **Baixar planilha** gera um arquivo do Excel com todos os atendimentos da temporada.

## Rodar no computador

Precisa do [Node.js](https://nodejs.org) 20 ou mais novo.

```bash
npm install
npm start
```

- **Clientes:** `http://<ip-do-computador>:3000` (o endereço aparece no topo do painel). O celular precisa estar no mesmo Wi‑Fi.
- **Wagner:** `http://localhost:3000/admin`, senha padrão `wagner123`.

Sem `DATABASE_URL`, os dados ficam em `data/dados.json`. Variáveis opcionais: `ADMIN_SENHA`, `PORT`, `DATA_DIR` (outra pasta de dados) e `PUBLIC_URL` (endereço usado no QR Code).

## Como funciona

1. O cliente informa **nome e sobrenome** e **WhatsApp** (os dois obrigatórios) e recebe uma senha (Nº 1, 2, 3…). A tela mostra em destaque a **tolerância de 5 minutos**. O mesmo WhatsApp não entra duas vezes na fila.
2. Quando a cadeira fica livre, o próximo é **chamado automaticamente**. O celular dele toca, vibra e mostra a mensagem padrão com a contagem regressiva. Quem está logo atrás vê **"Você é o próximo"**. Tudo atualiza na hora, sem recarregar.
   - O botão **"Avisar no WhatsApp"** abre a conversa com a mensagem pronta.
3. O cliente chega e o Wagner aperta **"Chegou · começar corte"**.
4. Se passar da tolerância, o cliente **perde a vez** e o próximo é chamado. Quem perdeu a vez pode **voltar ao fim da fila**.
5. Ao terminar, **"Chamar próximo"** conta o corte e já chama o seguinte. Sem ninguém esperando, o botão vira "Liberar cadeira".

### Cada dia é um dia novo

**Todo dia às 4h da manhã** a fila vira sozinha: as senhas voltam para o Nº 1 e o dia anterior é guardado. Às 4h, e não à meia-noite, para não cortar o atendimento do dia 31. Em **Dias de atendimento**, cada dia mostra os cortes e quem perdeu a vez; tocando no dia aparece a lista de quem passou.

### No painel do Wagner

- **Cadastrar quem não tem celular:** coloca a pessoa no fim da fila (telefone opcional).
- **Aberto / Pausa / Fechado:** em *Pausa* ninguém é chamado (almoço); em *Fechado* ninguém entra pelo celular.
- **X ao lado de cada registro:** apaga de vez um corte de teste ou um cadastro errado (some da lista e da contagem).
- **Configurações:**
  - **Recado do dia:** aparece no celular dos clientes (ex.: "Hoje atendo até 22h").
  - **Máximo de senhas por dia:** quando acaba, o celular mostra "senhas esgotadas". O Wagner ainda pode cadastrar na mão.
  - **Tolerância** e **mensagem padrão** (`{nome}` vira o primeiro nome, `{numero}` a senha, `{minutos}` a tolerância).
  - **Encerrar o dia agora:** para fechar antes das 4h.
