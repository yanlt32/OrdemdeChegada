# Fila da Barbearia do Wagner

Sistema simples de fila por ordem de chegada. O cliente pega a senha pelo celular e acompanha sua posição em tempo real; o Wagner controla tudo por um painel.

## Como rodar

Precisa do [Node.js](https://nodejs.org) 18 ou mais novo.

```bash
npm install
npm start
```

- **Clientes:** `http://<ip-do-computador>:3000` (o endereço aparece no topo do painel)
- **Wagner:** `http://localhost:3000/admin` — senha padrão `wagner123`

Para trocar a senha ou a porta:

```bash
# Windows (PowerShell)
$env:ADMIN_SENHA="minhasenha"; $env:PORT="8080"; npm start
```

> O celular do cliente precisa estar na mesma rede Wi‑Fi do computador que roda o sistema. Dica: imprima um QR Code com o endereço dos clientes e cole no espelho.

## Como funciona

1. O cliente informa **nome e sobrenome** e **WhatsApp** (os dois obrigatórios). Recebe uma senha (Nº 1, 2, 3…). A tela mostra em destaque a **tolerância de 5 minutos**.
2. Quando a cadeira fica livre, o próximo da fila é **chamado automaticamente**. O celular do cliente toca, vibra e mostra a **mensagem padrão** ("É a sua vez de cortar… tolerância de 5 minutos…") com a contagem regressiva. Quem está logo atrás vê o aviso **"Você é o próximo, fique por perto"**. Todas as telas abertas se atualizam na hora, sem recarregar.
   - Se o cliente deixou o WhatsApp, o Wagner tem o botão **"Avisar no WhatsApp"**, que já abre com a mensagem pronta.
   - O texto da mensagem pode ser editado em *Configurações* (use `{nome}` para o primeiro nome, `{numero}` e `{minutos}`).
3. O cliente tem **5 minutos** para se apresentar. O Wagner aperta **"Chegou · começar corte"**.
4. Se passar dos 5 minutos, o cliente **perde a vez** e o próximo é chamado. O Wagner pode colocar quem perdeu a vez de volta no fim da fila ("Voltar à fila").
5. Ao terminar, o Wagner aperta **"Chamar próximo"**: o corte de quem está na cadeira entra na conta e o próximo é chamado. Se ninguém estiver esperando, o botão vira "Liberar cadeira".

### No painel do Wagner

- **Cadastrar cliente sem celular:** adiciona a pessoa no fim da fila manualmente (telefone opcional).
- **Aberto / Pausa / Fechado:**
  - *Aberto* — recebe clientes e chama automaticamente.
  - *Pausa* — recebe clientes, mas ninguém é chamado (almoço, intervalo).
  - *Fechado* — clientes não conseguem entrar pelo celular (o Wagner ainda pode cadastrar manualmente).
- **Dashboard:** cortes de hoje, total geral, pessoas na fila, quem perdeu a vez, tempo médio por corte e cortes por dia.
- **Configurações:** tempo de tolerância, mensagem padrão e **"Encerrar o dia"** (zera a fila e as senhas, mantendo os cortes no total).

Os dados ficam salvos em `data/dados.json`.
