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


## Capas corrigidas

Quando o resultado não traz `poster_path`, o servidor procura outra imagem no endpoint
`/images` da TMDB. A ordem usada é:

1. pôster;
2. imagem de fundo;
3. capa substituta com o título.

Itens antigos salvos sem capa também são atualizados quando o painel abre.


## Episódio e temporada automáticos

Ao colocar uma série na overlay, o painel mostra os campos **Episódio** e
**Temporada**. Digitar um número ou clicar nas setas `▲` e `▼` atualiza a
overlay imediatamente, sem apertar outro botão.
