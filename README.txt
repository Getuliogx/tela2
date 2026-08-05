TELA2 — Render reconstruído e estável

Os arquivos deste ZIP ficam diretamente na raiz do GitHub. Não envie uma pasta `tela2-main` contendo os arquivos.

#Configuração do Web Service

```text
Root Directory: vazio
Build Command: npm install
Start Command: npm start
Health Check Path: /ping
```

#Endereços

```text
/        -> OK
/ping    -> OK
/health  -> diagnóstico JSON
/admin   -> painel
/state   -> estado da overlay
/events  -> atualizações SSE
```

#UptimeRobot

Use a URL completa terminando em `/ping`:

```text
https://SEU-SERVICO.onrender.com/ping
```

#Correções aplicadas

- estrutura achatada na raiz;
- Node 22 fixado com limite de versão;
- servidor ligado em `0.0.0.0` e `process.env.PORT`;
- `/`, `/ping` e `/health` aceitam GET e HEAD;
- conexão direta instável ao IRC da Twitch não inicia;
- comandos continuam por `/api/command` via StreamElements;
- nenhuma dependência externa é necessária para o servidor iniciar.
