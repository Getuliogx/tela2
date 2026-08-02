# tela2 — painel administrativo

Painel para pesquisar filmes e séries, salvar títulos e atualizar a overlay com um clique.

## Endereço do painel

```text
https://tela2.onrender.com/admin
```

## Render

```text
Build Command: npm install
Start Command: npm start
Health Check Path: /ping
```

## Senha opcional

Crie no Render a variável `ADMIN_PASSWORD` para proteger o painel. Sem essa variável, o painel abre sem senha.

## O que foi mantido

- `/state` e `/events`, usados pelo widget do StreamElements;
- comandos `!tf` e `!ts` no canal `icarolinaporto`;
- `!ts Elite EP1 - T2` e `!ts Elite T2 - EP1`;
- `/ping` para o UptimeRobot.

A lista também fica salva no navegador do painel, então continua aparecendo mesmo quando o Render reinicia.
