# tela2

Projeto corrigido usando o arquivo original enviado.

## Canal

```text
icarolinaporto
```

O canal está fixo no `server.js` e não depende de variável antiga do Render.

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

O comando `!ts Elite EP1 - T2` pesquisa apenas `Elite` na TMDB e envia ao StreamElements o título `Elite EP1 - T2`.

## Diagnóstico

```text
https://tela2.onrender.com/health
```

Depois de enviar um comando, `lastChatMessage` e `lastCommand` mostram o que o servidor recebeu.
