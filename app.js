/* Cartaozim: despesas do cartao por mes, sem login. Os lancamentos ficam guardados sob um codigo que vai no
   link (#c=...). O app le e grava pelo endpoint api/dados; guarda uma copia em localStorage para abrir rapido
   e para funcionar sem rede, e enfileira as gravacoes que falharem para tentar de novo. */
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var FUSO = 'America/Sao_Paulo';
  var MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

  /* ---------------- codigo (o "dono" dos dados) ---------------- */
  function gerarCodigo() {
    var alfabeto = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var bytes = new Uint8Array(24); crypto.getRandomValues(bytes);
    var s = ''; for (var i = 0; i < bytes.length; i++) s += alfabeto[bytes[i] % alfabeto.length];
    return s;
  }
  function extrairCodigo(texto) {
    var m = String(texto || '').match(/(?:[#&?]c=)?([A-Za-z0-9_-]{16,64})\s*$/);
    return m ? m[1] : null;
  }
  function codigoDoHash() { var m = location.hash.match(/[#&]c=([A-Za-z0-9_-]{16,64})/); return m ? m[1] : null; }
  function guardar(chave, valor) { try { localStorage.setItem(chave, valor); } catch (e) {} }
  function ler(chave) { try { return localStorage.getItem(chave); } catch (e) { return null; } }

  var codigo = codigoDoHash() || ler('cz-codigo');
  var primeiraVez = false;
  if (!codigo) { codigo = gerarCodigo(); primeiraVez = true; }
  guardar('cz-codigo', codigo);
  if (codigoDoHash() !== codigo) history.replaceState(null, '', location.pathname + location.search + '#c=' + codigo);

  /* ---------------- estado ---------------- */
  var itens = [];
  var fila = [];
  var hoje = hojeISO();
  var mes = hoje.slice(0, 7);
  var editando = null;      // item em edicao
  var armazem = null;       // 'redis' | 'memoria'
  var sincronizando = false;

  try { itens = JSON.parse(ler('cz-itens-' + codigo) || '[]'); } catch (e) { itens = []; }
  try { fila = JSON.parse(ler('cz-fila-' + codigo) || '[]'); } catch (e) { fila = []; }

  /* ---------------- utilidades ---------------- */
  function hojeISO() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  }
  function id() { var a = new Uint8Array(8); crypto.getRandomValues(a); return Date.now().toString(36) + Array.prototype.map.call(a, function (b) { return (b % 36).toString(36); }).join(''); }
  function dinheiro(centavos) {
    return (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }
  function nomeDoMes(ym) { var p = ym.split('-'); return MESES[parseInt(p[1], 10) - 1] + ' ' + p[0]; }
  function somarMeses(ym, n) { var p = ym.split('-').map(Number); var d = new Date(Date.UTC(p[0], p[1] - 1 + n, 1)); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); }
  function diasNoMes(ym) { var p = ym.split('-').map(Number); return new Date(Date.UTC(p[0], p[1], 0)).getUTCDate(); }
  function dataMaisMeses(iso, n) {
    var ym = somarMeses(iso.slice(0, 7), n); var dia = Math.min(parseInt(iso.slice(8, 10), 10), diasNoMes(ym));
    return ym + '-' + String(dia).padStart(2, '0');
  }
  function nomeDoDia(iso) {
    if (iso === hoje) return 'Hoje';
    if (iso === dataMaisDias(hoje, -1)) return 'Ontem';
    var d = new Date(iso + 'T12:00:00-03:00');
    return new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, weekday: 'short', day: '2-digit', month: 'short' }).format(d).replace(/\./g, '');
  }
  function dataMaisDias(iso, n) { var d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function toast(msg) { var t = $('#toast'); t.textContent = msg; t.classList.add('ver'); clearTimeout(toast.r); toast.r = setTimeout(function () { t.classList.remove('ver'); }, 2600); }
  function vivos() { return itens.filter(function (i) { return !i.apagado; }); }
  function doMes(ym) { return vivos().filter(function (i) { return i.data.slice(0, 7) === ym; }); }
  function total(lista) { return lista.reduce(function (s, i) { return s + (i.valor || 0); }, 0); }
  function guardarItens() { guardar('cz-itens-' + codigo, JSON.stringify(itens)); }
  function guardarFila() { guardar('cz-fila-' + codigo, JSON.stringify(fila)); }

  /* ---------------- api ---------------- */
  function api(metodo, corpo) {
    var url = 'api/dados' + (metodo === 'GET' ? '?c=' + encodeURIComponent(codigo) : '');
    return fetch(url, {
      method: metodo,
      headers: { 'Content-Type': 'application/json' },
      body: metodo === 'GET' ? undefined : JSON.stringify(Object.assign({ c: codigo }, corpo))
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok || !j.ok) throw new Error(j.erro || ('HTTP ' + r.status));
        return j;
      });
    });
  }
  function estado(classe, texto) { var e = $('#estado'); e.className = 'estado ' + classe; $('#estadoTexto').textContent = texto; }

  function carregar() {
    estado('', 'sincronizando');
    return api('GET').then(function (j) {
      armazem = j.armazem;
      var mapa = {};
      var doServidor = j.itens || [];
      if (armazem === 'redis') {
        // com banco de verdade, o que veio do servidor manda
        doServidor.forEach(function (i) { mapa[i.id] = i; });
      } else {
        // servidor sem banco (memoria): ele esquece tudo a cada reinicio, entao a copia deste navegador e a que
        // vale. Comeca pelo que esta aqui, deixa o servidor por cima (pode ter edicao mais nova) e devolve a ele
        // o que ele perdeu, em lotes, pela fila.
        itens.forEach(function (i) { mapa[i.id] = i; });
        var noServidor = {};
        doServidor.forEach(function (i) { noServidor[i.id] = true; mapa[i.id] = i; });
        var perdidos = itens.filter(function (i) { return !noServidor[i.id]; });
        for (var k = 0; k < perdidos.length; k += 48) fila.push({ op: 'salvar', itens: perdidos.slice(k, k + 48) });
        if (perdidos.length) guardarFila();
      }
      // o que esta na fila (ainda nao enviado) fica por cima
      fila.forEach(function (op) {
        if (op.op === 'salvar') op.itens.forEach(function (i) { mapa[i.id] = i; });
        if (op.op === 'apagar') op.ids.forEach(function (idx) { delete mapa[idx]; });
      });
      itens = Object.keys(mapa).map(function (k) { return mapa[k]; });
      guardarItens();
      render();
      avisoArmazem();
      return processarFila();
    }).catch(function (e) {
      estado('erro', 'sem conexão');
      render();
      console.warn('carregar', e);
    });
  }
  function enfileirar(op) { fila.push(op); guardarFila(); return processarFila(); }
  function processarFila() {
    if (sincronizando) return Promise.resolve();
    if (!fila.length) { estado('ok', 'salvo'); return Promise.resolve(); }
    sincronizando = true;
    estado('pendente', 'enviando');
    var op = fila[0];
    return api('POST', op).then(function () {
      fila.shift(); guardarFila(); sincronizando = false;
      return processarFila();
    }).catch(function (e) {
      sincronizando = false;
      estado('erro', fila.length + (fila.length === 1 ? ' pendente' : ' pendentes'));
      console.warn('fila', e);
    });
  }
  function avisoArmazem() {
    var a = $('#armazemAviso');
    if (armazem !== 'redis') { a.hidden = false; a.textContent = 'Atenção: o servidor está sem banco conectado. Os lançamentos ficam guardados neste navegador, mas não aparecem em outro celular até o Redis ser ligado na Vercel.'; }
    else a.hidden = true;
  }

  /* ---------------- render ---------------- */
  function render() {
    var lista = doMes(mes).sort(function (a, b) { return a.data < b.data ? 1 : a.data > b.data ? -1 : (a.criado_em < b.criado_em ? 1 : -1); });
    var t = total(lista);
    $('#mesNome').textContent = nomeDoMes(mes);
    $('#total').textContent = dinheiro(t);
    $('#contagem').textContent = lista.length === 0 ? 'nenhum lançamento' : lista.length === 1 ? '1 lançamento' : lista.length + ' lançamentos';
    var anterior = total(doMes(somarMeses(mes, -1)));
    var comp = $('#comparacao');
    if (anterior > 0 && t > 0) {
      var dif = t - anterior; comp.className = 'comparacao ' + (dif > 0 ? 'sobe' : dif < 0 ? 'desce' : '');
      comp.textContent = dinheiro(Math.abs(dif)) + ' que o mês anterior';
    } else { comp.className = 'comparacao'; comp.textContent = anterior > 0 ? 'mês anterior: ' + dinheiro(anterior) : ''; }
    $('#irHoje').hidden = mes === hoje.slice(0, 7);

    // resumo por cartao
    var porCartao = {};
    lista.forEach(function (i) { if (i.cartao) porCartao[i.cartao] = (porCartao[i.cartao] || 0) + i.valor; });
    var chaves = Object.keys(porCartao).sort(function (a, b) { return porCartao[b] - porCartao[a]; });
    var ul = $('#cartoesResumo');
    ul.hidden = chaves.length === 0;
    ul.innerHTML = chaves.map(function (c) { return '<li><b>' + esc(c) + '</b>' + dinheiro(porCartao[c]) + '</li>'; }).join('');

    // sugestoes de cartao
    var todos = {}; vivos().forEach(function (i) { if (i.cartao) todos[i.cartao] = 1; });
    $('#cartoesLista').innerHTML = Object.keys(todos).sort().map(function (c) { return '<option value="' + esc(c) + '">'; }).join('');

    // lista por dia
    var box = $('#lista');
    if (!lista.length) {
      box.innerHTML = '<div class="vazio"><div class="glifo"><svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="13" rx="3"/><path d="M3 10h18M7 15h4"/></svg></div><b>Nada lançado em ' + esc(nomeDoMes(mes)) + '</b>Toque no + para anotar uma despesa.</div>';
      return;
    }
    var html = '', diaAtual = null, grupo = [];
    function fecharDia() {
      if (!grupo.length) return;
      html += '<div class="dia"><span>' + esc(nomeDoDia(diaAtual)) + '</span><span>' + dinheiro(total(grupo)) + '</span></div><ul class="itens">' +
        grupo.map(function (i) {
          var meta = [];
          if (i.cartao) meta.push('<span>' + esc(i.cartao) + '</span>');
          if (i.parcela) meta.push('<span>parcela ' + esc(i.parcela) + '</span>');
          return '<li><button class="item" type="button" data-id="' + esc(i.id) + '"><span class="item-desc">' + esc(i.descricao) + '</span>' +
            (meta.length ? '<span class="item-meta">' + meta.join('') + '</span>' : '') +
            '<span class="item-valor">' + dinheiro(i.valor) + '</span></button></li>';
        }).join('') + '</ul>';
      grupo = [];
    }
    lista.forEach(function (i) { if (i.data !== diaAtual) { fecharDia(); diaAtual = i.data; } grupo.push(i); });
    fecharDia();
    box.innerHTML = html;
  }

  /* ---------------- meses ---------------- */
  $('#mesAnterior').addEventListener('click', function () { mes = somarMeses(mes, -1); render(); });
  $('#mesSeguinte').addEventListener('click', function () { mes = somarMeses(mes, 1); render(); });
  $('#irHoje').addEventListener('click', function () { mes = hoje.slice(0, 7); render(); });
  $('#mesNome').addEventListener('click', function () { mes = hoje.slice(0, 7); render(); });

  /* ---------------- folhas ---------------- */
  function abrirFolha(nome) { $('#veu' + nome).hidden = false; $('#folha' + nome).hidden = false; document.body.style.overflow = 'hidden'; }
  function fecharFolha(nome) { $('#veu' + nome).hidden = true; $('#folha' + nome).hidden = true; document.body.style.overflow = ''; }
  ['Form', 'Apagar', 'Ajustes'].forEach(function (n) { $('#veu' + n).addEventListener('click', function () { fecharFolha(n); }); });
  $('#fecharForm').addEventListener('click', function () { fecharFolha('Form'); });
  $('#fecharAjustes').addEventListener('click', function () { fecharFolha('Ajustes'); });
  $('#apagarCancelar').addEventListener('click', function () { fecharFolha('Apagar'); });
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') ['Form', 'Apagar', 'Ajustes'].forEach(fecharFolha); });

  /* ---------------- campo de valor em reais ---------------- */
  var campoValor = $('#valor');
  function centavosDoCampo() { var d = campoValor.value.replace(/\D/g, ''); return d ? parseInt(d, 10) : 0; }
  function formatarCampo() {
    var d = campoValor.value.replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, 10);
    campoValor.value = d ? dinheiro(parseInt(d, 10)) : '';
    atualizarDicaParcelas();
  }
  campoValor.addEventListener('input', formatarCampo);
  campoValor.addEventListener('focus', function () { setTimeout(function () { campoValor.setSelectionRange(campoValor.value.length, campoValor.value.length); }, 0); });

  /* ---------------- parcelas ---------------- */
  var selParcelas = $('#parcelas');
  selParcelas.innerHTML = Array.from({ length: 24 }, function (_, i) { var n = i + 1; return '<option value="' + n + '">' + (n === 1 ? 'À vista (1x)' : n + 'x') + '</option>'; }).join('');
  selParcelas.addEventListener('change', atualizarDicaParcelas);
  function atualizarDicaParcelas() {
    var n = parseInt(selParcelas.value, 10), c = centavosDoCampo(), d = $('#dicaParcelas');
    if (n > 1 && c > 0) d.textContent = n + ' parcelas de ' + dinheiro(Math.floor(c / n)) + (c % n ? ' (a primeira ajusta os centavos)' : '') + ', uma por mês a partir da data.';
    else d.textContent = n > 1 ? 'Uma parcela por mês a partir da data escolhida.' : '';
  }

  /* ---------------- novo / editar ---------------- */
  $('#novo').addEventListener('click', function () {
    editando = null;
    $('#folhaTitulo').textContent = 'Nova despesa';
    $('#form').reset();
    $('#data').value = mes === hoje.slice(0, 7) ? hoje : mes + '-01';
    selParcelas.value = '1';
    $('#campoParcelas').hidden = false;
    $('#parcelaInfo').hidden = true;
    $('#apagar').hidden = true;
    atualizarDicaParcelas();
    abrirFolha('Form');
    setTimeout(function () { campoValor.focus(); }, 60);
  });
  $('#lista').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-id]'); if (!b) return;
    var item = itens.find(function (i) { return i.id === b.getAttribute('data-id'); }); if (!item) return;
    editando = item;
    $('#folhaTitulo').textContent = 'Editar despesa';
    campoValor.value = dinheiro(item.valor);
    $('#descricao').value = item.descricao;
    $('#data').value = item.data;
    $('#cartao').value = item.cartao || '';
    $('#campoParcelas').hidden = true;
    var info = $('#parcelaInfo');
    if (item.parcela) { info.hidden = false; info.textContent = 'Parcela ' + item.parcela + '. A edição vale só para esta parcela.'; } else info.hidden = true;
    $('#apagar').hidden = false;
    abrirFolha('Form');
  });

  $('#form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var valor = centavosDoCampo();
    var descricao = $('#descricao').value.trim();
    var data = $('#data').value;
    var cartao = $('#cartao').value.trim();
    if (!valor) { toast('Digite o valor.'); campoValor.focus(); return; }
    if (!descricao) { toast('Digite uma descrição.'); $('#descricao').focus(); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) { toast('Escolha a data.'); $('#data').focus(); return; }
    var agora = new Date().toISOString();
    var novos = [];
    if (editando) {
      var alterado = Object.assign({}, editando, { valor: valor, descricao: descricao, data: data, cartao: cartao, atualizado_em: agora });
      novos = [alterado];
    } else {
      var n = parseInt(selParcelas.value, 10) || 1;
      var grupo = n > 1 ? id() : '';
      var base = Math.floor(valor / n), resto = valor - base * n;
      for (var k = 0; k < n; k++) {
        novos.push({ id: id(), data: dataMaisMeses(data, k), descricao: descricao, valor: base + (k === 0 ? resto : 0), cartao: cartao, parcela: n > 1 ? (k + 1) + '/' + n : '', grupo: grupo, criado_em: agora, atualizado_em: agora });
      }
    }
    // aplica localmente na hora e manda para o servidor
    novos.forEach(function (nv) { var ix = itens.findIndex(function (i) { return i.id === nv.id; }); if (ix >= 0) itens[ix] = nv; else itens.push(nv); });
    guardarItens();
    fecharFolha('Form');
    render();
    toast(editando ? 'Despesa atualizada.' : (novos.length > 1 ? novos.length + ' parcelas lançadas.' : 'Despesa lançada.'));
    enfileirar({ op: 'salvar', itens: novos });
  });

  /* ---------------- apagar ---------------- */
  $('#apagar').addEventListener('click', function () {
    if (!editando) return;
    if (editando.grupo) {
      $('#apagarTexto').textContent = '"' + editando.descricao + '" é a parcela ' + editando.parcela + ' de uma compra parcelada.';
      $('#apagarUma').hidden = false; $('#apagarTodas').hidden = false;
      fecharFolha('Form'); abrirFolha('Apagar');
    } else {
      $('#apagarTexto').textContent = '"' + editando.descricao + '", ' + dinheiro(editando.valor) + '.';
      $('#apagarUma').hidden = false; $('#apagarUma').textContent = 'Apagar'; $('#apagarTodas').hidden = true;
      fecharFolha('Form'); abrirFolha('Apagar');
    }
  });
  function apagarIds(ids) {
    itens = itens.filter(function (i) { return ids.indexOf(i.id) === -1; });
    guardarItens(); fecharFolha('Apagar'); render();
    toast(ids.length > 1 ? ids.length + ' parcelas apagadas.' : 'Despesa apagada.');
    enfileirar({ op: 'apagar', ids: ids });
    editando = null;
  }
  $('#apagarUma').addEventListener('click', function () { if (editando) apagarIds([editando.id]); $('#apagarUma').textContent = 'Apagar só esta parcela'; });
  $('#apagarTodas').addEventListener('click', function () { if (!editando) return; var g = editando.grupo; apagarIds(itens.filter(function (i) { return i.grupo === g; }).map(function (i) { return i.id; })); });

  /* ---------------- ajustes e link ---------------- */
  function linkAtual() { return location.origin + location.pathname + '#c=' + codigo; }
  function abrirAjustes(intro) {
    $('#linkTexto').textContent = linkAtual();
    $('#ajustesIntro').textContent = intro || 'Os lançamentos ficam guardados neste link. Abra o mesmo link em outro celular e tudo aparece lá também. Quem não tiver o link não vê nada.';
    $('#compartilharLink').hidden = !navigator.share;
    avisoArmazem();
    abrirFolha('Ajustes');
  }
  $('#abrirAjustes').addEventListener('click', function () { abrirAjustes(); });
  $('#copiarLink').addEventListener('click', function () {
    navigator.clipboard.writeText(linkAtual()).then(function () { toast('Link copiado.'); }, function () { toast(linkAtual()); });
  });
  $('#compartilharLink').addEventListener('click', function () {
    navigator.share({ title: 'Cartãozim', text: 'Meu Cartãozim', url: linkAtual() }).catch(function () {});
  });
  $('#formTrocar').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var novo = extrairCodigo($('#codigoNovo').value.trim());
    if (!novo) { toast('Não achei um código válido aí.'); return; }
    if (novo === codigo) { toast('Esse já é o seu código.'); return; }
    guardar('cz-codigo', novo);
    location.hash = 'c=' + novo;
    location.reload();
  });
  $('#exportar').addEventListener('click', function () {
    var lista = doMes(mes).sort(function (a, b) { return a.data < b.data ? -1 : 1; });
    var linhas = [['data', 'descricao', 'valor', 'cartao', 'parcela']].concat(lista.map(function (i) {
      return [i.data, i.descricao, (i.valor / 100).toFixed(2).replace('.', ','), i.cartao || '', i.parcela || ''];
    }));
    var csv = '﻿' + linhas.map(function (l) { return l.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(';'); }).join('\r\n');
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'cartaozim-' + mes + '.csv'; document.body.appendChild(a); a.click(); a.remove();
  });

  /* ---------------- arranque ---------------- */
  render();
  carregar();
  if (primeiraVez) setTimeout(function () { abrirAjustes('Este é o seu Cartãozim. Guarde este link: é ele que abre as suas despesas em qualquer celular. Quem não tiver o link não vê nada.'); }, 400);
  window.addEventListener('online', function () { processarFila(); });
  window.addEventListener('hashchange', function () { var c = codigoDoHash(); if (c && c !== codigo) { guardar('cz-codigo', c); location.reload(); } });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) carregar(); });
  setInterval(function () { if (!document.hidden) carregar(); }, 60000);
  if ('serviceWorker' in navigator && location.protocol === 'https:') { navigator.serviceWorker.register('sw.js').catch(function () {}); }
})();
