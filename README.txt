TELA2 - PAINEL ADM

PAINEL:
https://tela2.onrender.com/admin

RENDER:
Build Command: npm install
Start Command: npm start
Health Check Path: /ping

USO:
1. Pesquise um filme ou uma serie.
2. Clique em Salvar para guardar na lista.
3. Clique em Atualizar overlay para trocar o card imediatamente.
4. O campo Complemento aceita, por exemplo: EP1 - T2.

SENHA OPCIONAL:
Variavel do Render: ADMIN_PASSWORD


CAPAS:
- procura poster alternativo na TMDB;
- usa backdrop quando nao existe poster;
- cria capa com o titulo quando nao existe nenhuma imagem;
- corrige itens antigos salvos sem capa.


EPISODIO E TEMPORADA:
- aparecem automaticamente quando a overlay atual e uma serie;
- digitar atualiza sozinho;
- clicar nas setas para cima ou para baixo atualiza sozinho.


EXCLUIR DA OVERLAY:
- botao "Excluir da overlay" no painel;
- comando !t no chat.


COMANDO PARA PROXIMO EPISODIO:
!d

EXEMPLO:
Elite EP1 - T2
!d
Elite EP2 - T2


PROGRESSO POR SERIE:
- cada serie guarda seu proprio episodio e temporada;
- trocar de conteudo nao apaga;
- usar !t nao apaga;
- excluir da lista nao apaga;
- ao colocar a serie novamente, o EP/T antigo volta automaticamente;
- !d e as setas do painel atualizam o progresso salvo.


CORRECAO DE COMANDO DUPLICADO:
- comandos somente pelo StreamElements;
- leitura direta do chat Twitch desativada no Render;
- mesmo evento recebido duas vezes e ignorado;
- !d avanca somente um episodio.


PATROCINIO NO MESMO SERVIDOR:
- opção abaixo dos títulos salvos;
- digite o nick;
- aparece como Patrocionio: Papiluni;
- servidor único: https://tela2.onrender.com.


PATROCINIO EMBAIXO DE CADA TITULO:
- removida a caixa grande separada;
- campo fica dentro de cada filme/serie salvo;
- o texto digitado nao e mais apagado pelo refresh;
- cada titulo guarda seu proprio patrocinador.


CORRECAO DO NICK:
- digite o nick no card salvo;
- clique em Atualizar overlay;
- o nick e salvo e enviado junto;
- Enter no campo tambem atualiza.


CORRECAO TITULO SALVO NAO ENCONTRADO:
- o titulo e recriado automaticamente no servidor;
- Salvar patrocinio funciona em cards antigos do navegador;
- Atualizar overlay salva o nick junto;
- nao precisa excluir nem salvar o filme novamente.
