# tela2

Esta versão não tenta ler o chat da Twitch pelo Render.

O próprio widget do StreamElements recebe `!tf` e `!ts` e envia o comando para o Render.

## Render

```text
Build Command: npm install
Start Command: npm start
Health Check Path: /ping
```

## Comandos

```text
!tf Alien 1979
!ts Elite 2018
!ts Elite EP1 - T2
!ts Elite T2 - EP1
```

## Rotas

```text
GET  /ping
GET  /health
GET  /state
GET  /events
POST /command
```
