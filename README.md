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


## Excluir o conteúdo da overlay

No painel, clique em **Excluir da overlay**.

No chat da Twitch, use:

```text
!t
```

O título, pôster, episódio e temporada são removidos da overlay.


## Próximo episódio pelo chat

Use:

```text
!d
```

Exemplo:

```text
Elite EP1 - T2
```

depois de `!d` vira:

```text
Elite EP2 - T2
```

A temporada é mantida. Se a série ainda não tiver episódio, `!d` começa em `EP1 - T1`.


## Correção do comando !d

O `!d` agora é recebido pelo próprio StreamElements e enviado para:

```text
POST /api/command
```

Isso evita depender da conexão direta do Render com o chat da Twitch.


## Progresso separado para cada série

O servidor guarda o último episódio e a última temporada usando o ID da série
na TMDB.

Exemplo:

1. `Elite EP8 - T3`
2. troca para um filme ou outra série;
3. exclui o conteúdo da overlay;
4. coloca `Elite` novamente.

A overlay volta automaticamente em:

```text
Elite EP8 - T3
```

O comando `!d` e as setas do painel também atualizam esse progresso.
Excluir da overlay ou excluir o título da lista não apaga o progresso da série.


## Correção de comando duplicado

Os comandos agora entram somente pelo StreamElements. A conexão direta do
Render com o chat da Twitch foi desativada.

O servidor também ignora o mesmo evento recebido novamente durante 2 segundos.
Assim, mesmo com as overlays da Twitch e da Kick abertas, um único `!d` avança
somente um episódio.


## Patrocínio no mesmo servidor

O painel em `/admin` agora possui uma seção **Patrocínio**, abaixo dos títulos
salvos. Digite o nick e clique em **Atualizar patrocínio**.

A overlay recebe tudo por:

```text
https://tela2.onrender.com/state
https://tela2.onrender.com/events
```

Formato exibido:

```text
Patrocionio: Papiluni
```

Não é usado nenhum outro servidor.


## Patrocínio embaixo de cada filme/série salvo

A caixa grande de patrocínio foi removida.

Cada título salvo agora possui, dentro do próprio card:

- campo para digitar o nick;
- botão **Salvar patrocínio**;
- botão **Remover**.

O painel não atualiza nem apaga o texto enquanto você está digitando. Cada
filme ou série guarda seu próprio patrocinador. Ao colocar aquele título na
overlay, aparece:

```text
Patrocionio: Papiluni
```


## Correção do nick na overlay

Agora basta digitar o nick no card salvo e clicar em **Atualizar overlay**.
O painel salva o patrocinador primeiro e envia o título já com:

```text
Patrocionio: Papiluni
```

Não é necessário clicar antes em **Salvar patrocínio**. Pressionar Enter no
campo também atualiza a overlay.


## Correção do erro “Título salvo não encontrado”

Os cards podem continuar no navegador depois que um deploy do Render apaga
`saved.json`. Agora, ao salvar o nick ou atualizar a overlay, o painel envia
também os dados completos do filme/série e o servidor recria o título
automaticamente.

Não é mais necessário salvar o título novamente.
