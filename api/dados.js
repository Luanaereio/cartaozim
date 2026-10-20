/* Cartaozim, endpoint na Vercel: le e grava os lancamentos de um codigo.
   GET  /api/dados?c=<codigo>                        -> { ok, itens: [...], armazem }
   POST /api/dados  { c, op: 'salvar', itens: [...] } -> { ok }
   POST /api/dados  { c, op: 'apagar', ids: [...] }   -> { ok }
   Armazem: Redis do Upstash ligado pela Vercel (Storage > Upstash Redis). Sem as variaveis de ambiente, cai num
   armazem em memoria (so para desenvolvimento; some a cada reinicio). Cada codigo e um HASH do Redis
   (campo = id do lancamento, valor = JSON), entao cada gravacao e atomica e nao ha o que mesclar. */
'use strict';

var LIMITE_ITENS = 5000;
var LIMITE_LOTE = 48;

function erro(status, mensagem) { var e = new Error(mensagem); e.status = status; return e; }

function armazem() {
  var url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  var token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return redis(url, token);
  return memoria();
}

function redis(url, token) {
  async function cmd(args) {
    var r = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
    var j = await r.json();
    if (j.error) throw erro(502, 'redis: ' + j.error);
    return j.result;
  }
  return {
    tipo: 'redis',
    listar: async function (chave) {
      var plano = await cmd(['HGETALL', chave]) || [];
      var itens = [];
      for (var i = 0; i < plano.length; i += 2) { try { itens.push(JSON.parse(plano[i + 1])); } catch (e) {} }
      return itens;
    },
    contar: function (chave) { return cmd(['HLEN', chave]); },
    salvar: function (chave, itens) { var args = ['HSET', chave]; itens.forEach(function (it) { args.push(it.id, JSON.stringify(it)); }); return cmd(args); },
    apagar: function (chave, ids) { return cmd(['HDEL', chave].concat(ids)); }
  };
}

var MEMORIA = globalThis.__cartaozimMemoria || (globalThis.__cartaozimMemoria = new Map());
function memoria() {
  function hash(chave) { if (!MEMORIA.has(chave)) MEMORIA.set(chave, new Map()); return MEMORIA.get(chave); }
  return {
    tipo: 'memoria',
    listar: async function (chave) { return Array.from(hash(chave).values()); },
    contar: async function (chave) { return hash(chave).size; },
    salvar: async function (chave, itens) { var h = hash(chave); itens.forEach(function (it) { h.set(it.id, it); }); },
    apagar: async function (chave, ids) { var h = hash(chave); ids.forEach(function (i) { h.delete(i); }); }
  };
}

function validarCodigo(c) {
  if (typeof c !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(c)) throw erro(400, 'codigo invalido');
  return c;
}
function validarId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{6,40}$/.test(id)) throw erro(400, 'id invalido');
  return id;
}
function texto(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max); }
function validarItem(it) {
  if (!it || typeof it !== 'object') throw erro(400, 'lancamento invalido');
  var valor = Number(it.valor);
  if (!Number.isInteger(valor) || valor < 0 || valor > 99999999) throw erro(400, 'valor invalido');
  if (typeof it.data !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(it.data)) throw erro(400, 'data invalida');
  var parcela = texto(it.parcela, 7);
  if (parcela && !/^\d{1,2}\/\d{1,2}$/.test(parcela)) throw erro(400, 'parcela invalida');
  var grupo = texto(it.grupo, 40);
  if (grupo) validarId(grupo);
  var agora = new Date().toISOString();
  return {
    id: validarId(it.id),
    data: it.data,
    descricao: texto(it.descricao, 120),
    valor: valor,
    cartao: texto(it.cartao, 40),
    parcela: parcela,
    grupo: grupo,
    criado_em: typeof it.criado_em === 'string' && it.criado_em.length <= 30 ? it.criado_em : agora,
    atualizado_em: agora
  };
}

async function lerCorpo(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  var pedacos = [];
  for await (var p of req) pedacos.push(p);
  var bruto = Buffer.concat(pedacos).toString('utf8');
  return bruto ? JSON.parse(bruto) : {};
}

module.exports = async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    var arm = armazem();
    if (req.method === 'GET') {
      var q = req.query || {};
      var c = validarCodigo(q.c);
      var itens = await arm.listar('cz:' + c);
      return res.status(200).json({ ok: true, itens: itens, armazem: arm.tipo });
    }
    if (req.method === 'POST') {
      var corpo = await lerCorpo(req);
      var chave = 'cz:' + validarCodigo(corpo.c);
      if (corpo.op === 'salvar') {
        var lote = Array.isArray(corpo.itens) ? corpo.itens : [corpo.item];
        if (!lote.length || lote.length > LIMITE_LOTE) throw erro(400, 'lote invalido');
        var validos = lote.map(validarItem);
        var n = await arm.contar(chave);
        if (n + validos.length > LIMITE_ITENS) throw erro(413, 'limite de lancamentos atingido');
        await arm.salvar(chave, validos);
        return res.status(200).json({ ok: true, armazem: arm.tipo });
      }
      if (corpo.op === 'apagar') {
        var ids = (Array.isArray(corpo.ids) ? corpo.ids : [corpo.id]).map(validarId);
        if (!ids.length || ids.length > LIMITE_LOTE) throw erro(400, 'lote invalido');
        await arm.apagar(chave, ids);
        return res.status(200).json({ ok: true, armazem: arm.tipo });
      }
      throw erro(400, 'operacao desconhecida');
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, erro: 'metodo nao permitido' });
  } catch (e) {
    var status = e.status || (e instanceof SyntaxError ? 400 : 500);
    return res.status(status).json({ ok: false, erro: e.message || 'erro' });
  }
};
