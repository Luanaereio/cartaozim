# Cartãozim

App para anotar as despesas do cartão, mês a mês, feito para o celular e aberto pelo mesmo link em qualquer
aparelho, sem login. Página estática (`index.html`, `estilo.css`, `app.js`) + um endpoint na Vercel
(`api/dados.js`) que guarda os lançamentos num Redis gratuito (Upstash) ligado ao projeto.

## Como funciona

- Na primeira abertura o app cria um **código** e o coloca no link (`#c=...`). Esse código é a "conta": quem
  abre o mesmo link vê os mesmos lançamentos. Quem não tem o link não vê nada. Em **Ajustes** (engrenagem)
  dá para copiar, compartilhar ou trocar o código.
- Cada lançamento tem valor, descrição, data, cartão (opcional) e, se for parcelado, uma linha por mês
  (1/3, 2/3, 3/3). Toque num lançamento para editar ou apagar.
- O app guarda uma cópia no próprio celular para abrir rápido e funcionar sem rede; gravações que falharem
  ficam na fila e são reenviadas quando a conexão volta.
- Instalável: "Adicionar à tela inicial" com o link aberto.

## Publicar na Vercel

1. Importar o repositório (Framework: Other, sem build).
2. No projeto, aba **Storage** > **Create Database** > **Upstash** (Redis) > plano gratuito > conectar ao
   projeto. A Vercel cria as variáveis `KV_REST_API_URL` e `KV_REST_API_TOKEN` (ou `UPSTASH_REDIS_REST_URL`
   e `UPSTASH_REDIS_REST_TOKEN`); o endpoint aceita qualquer um dos dois pares.
3. Fazer um redeploy. Enquanto o Redis não estiver ligado, o app avisa em Ajustes que está em modo de teste
   (os dados ficam só no navegador).

## Desenvolvimento

Sem dependências. Para rodar local, qualquer servidor estático que também execute `api/dados.js` como
função (por exemplo `vercel dev`). Sem as variáveis do Redis o endpoint usa um armazém em memória.
