// ==UserScript==
// @name         Varejo Fácil - Agente de Compras
// @namespace    emporiodoreal
// @version      5.6
// @description  Sugestão de compra cruzando entradas x vendas + validação de licença (Supabase)
// @match        https://*.varejofacil.com/app/*
// @grant        GM_xmlhttpRequest
// @connect      *.varejofacil.com
// @connect      pjmyejohyzcfhawspceq.supabase.co
// @require      https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js
// @updateURL    https://raw.githubusercontent.com/aliamiri186/agente-de-compras/main/agente-de-compras.user.js
// @downloadURL  https://raw.githubusercontent.com/aliamiri186/agente-de-compras/main/agente-de-compras.user.js
// ==/UserScript==

(function () {
  'use strict';
  var POOL =12; // paralelismo (lotes)

  // ===== Licenca por E-MAIL + Trial 7 dias (v5.0) =====
  var AGENTE_EMAIL_KEY = 'agente_email_licenca';
  var AGENTE_CACHE_KEY = 'agente_licenca_cache';
  var VALIDAR_URL = "https://pjmyejohyzcfhawspceq.supabase.co/functions/v1/validar-licenca";

  function obterEmail() {
    var salvo = '';
    try { salvo = (localStorage.getItem(AGENTE_EMAIL_KEY) || '').trim(); } catch (e) {}
    if (salvo) return salvo;
    var email = prompt('Agente de Compras\n\nDigite seu e-mail para ativar o agente.\nVoce ganha 7 dias GRATIS, sem cartao.');
    if (email) {
      email = email.trim().toLowerCase();
      try { localStorage.setItem(AGENTE_EMAIL_KEY, email); } catch (e) {}
    }
    return email;
  }

  function validarLicenca(email) {
    return new Promise(function (resolve) {
      try {
        var c = JSON.parse(localStorage.getItem(AGENTE_CACHE_KEY) || 'null');
        if (c && c.email === email && c.exp > Date.now()) { resolve(c.data); return; }
      } catch (e) {}
      GM_xmlhttpRequest({
        method: 'POST',
        url: VALIDAR_URL,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ email: email }),
        onload: function (r) {
          var data;
          try { data = JSON.parse(r.responseText); } catch (e) { data = { ok: false, motivo: 'resposta_invalida' }; }
          try {
            if (data && data.ok) {
              localStorage.setItem(AGENTE_CACHE_KEY, JSON.stringify({ email: email, data: data, exp: Date.now() + 12 * 3600 * 1000 }));
            }
          } catch (e) {}
          resolve(data);
        },
        onerror: function () { resolve({ ok: false, motivo: 'erro_conexao' }); }
      });
    });
  }

  function mensagemBloqueio(lic) {
    var m = (lic && lic.motivo) || '';
    if (m === 'trial_expirado') {
      return 'Seu periodo de teste GRATIS de 7 dias terminou.\n\nPara continuar usando o Agente de Compras, assine na pagina do produto na Hotmart.';
    }
    if (m === 'expirada') {
      return 'Sua assinatura expirou.\n\nRenove na pagina do produto na Hotmart para continuar usando.';
    }
    if (m === 'email_invalido') {
      return 'E-mail invalido. Limpe e tente novamente com um e-mail valido.';
    }
    if (m === 'erro_conexao') {
      return 'Nao foi possivel conectar ao servidor de licenca. Verifique sua internet e tente de novo.';
    }
    return 'Licenca invalida. Acesse a pagina do produto na Hotmart para assinar.';
  }

  function checarAcesso() {
    var email = obterEmail();
    if (!email) { alert('E-mail nao informado. O agente nao sera executado.'); return Promise.resolve(false); }
    return validarLicenca(email).then(function (lic) {
      if (lic && lic.ok) {
        if (lic.status === 'trial' && lic.novo_trial) {
          alert('Bem-vindo! Seu teste GRATIS de 7 dias foi ativado.\nAproveite o Agente de Compras sem custo ate o fim do periodo.');
        }
        return true;
      }
      alert(mensagemBloqueio(lic));
      return false;
    });
  }

  const DIAS_GIRO = 120;
  const DIAS_CORTE_ENTRADA = 365;
  const JANELA_VENDAS = 400;
  
  function apiGet(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: location.origin + url,
        headers: { 'Accept': 'application/json' },
        timeout: 60000,
        onload: r => {
          if (r.status >= 200 && r.status < 300) {
            try { resolve(JSON.parse(r.responseText)); }
            catch (e) { reject('JSON inválido: ' + e); }
          } else reject(r.status + ' ' + r.responseText.slice(0, 120));
        },
        onerror: () => reject('erro de rede'),
        ontimeout: () => reject('timeout')
      });
    });
  }

  function mdc(a, b) { return b ? mdc(b, a % b) : a; }
  function mdcLista(arr) {
    const ns = arr.map(n => Math.round(n)).filter(n => n > 0);
    if (!ns.length) return 1;
    return ns.reduce((g, n) => mdc(g, n)) || 1;
  }
  function diasDesde(dataStr) {
    if (!dataStr) return Infinity;
    return Math.floor((Date.now() - new Date(dataStr).getTime()) / 86400000);
  }
  function setBtn(txt) {
    const b = document.getElementById('vf-agente-btn');
    if (b) b.textContent = txt;
  }
  function idValido(v) { const n = Number(String(v).trim()); return Number.isInteger(n) && n > 0; }
  function normId(v) { return Number(String(v).trim()); }

  async function emLotes(itens, fn, pool, rotulo) {
    const res = [];
    for (let i = 0; i < itens.length; i += pool) {
      const r = await Promise.all(itens.slice(i, i + pool).map(fn));
      res.push(...r);
      if (rotulo) setBtn('⏳ ' + rotulo + ' ' + Math.min(i + pool, itens.length) + '/' + itens.length);
    }
    return res;
  }

  async function coletarEntradas(fornecedorId, lojaFiltro) {
    let start = 0, todas = [];
    while (true) {
      const q = `fornecedorId==${fornecedorId};${lojaFiltro};tipoDeOperacao==ENTRADA`;
      const pg = await apiGet(`/api/v1/compra/notas-fiscais?q=${q}&sort=-dataEmissao&count=50&start=${start}`);
      const items = pg.items || [];
      todas = todas.concat(items);
      if (items.length < 50) break;
      start += 50;
      setBtn('⏳ Buscando notas ' + todas.length + '...');
    }
    return todas;
  }

  async function rodarAgente(fornecedorId, lojaFiltro) {
    setBtn('⏳ Buscando notas...');
    const notas = await coletarEntradas(fornecedorId, lojaFiltro);
    if (!notas.length) { alert('Nenhuma nota de entrada encontrada.'); return null; }

    const prod = {};
    notas.forEach(nota => {
      const dataEmis = nota.dataEmissao;
      (nota.itens || []).forEach(it => {
        const pid = it.produtoId;
        if (!prod[pid]) prod[pid] = { totalEntrada: 0, qtds: [], ultEnt: null, qtdUltEnt: 0 };
        const q = it.quantidade || 0;
        prod[pid].totalEntrada += q;
        prod[pid].qtds.push(q);
        if (!prod[pid].ultEnt || new Date(dataEmis) > new Date(prod[pid].ultEnt)) {
          prod[pid].ultEnt = dataEmis;
          prod[pid].qtdUltEnt = q;
        }
      });
    });

    const limiteEntrada = Date.now() - DIAS_CORTE_ENTRADA * 86400000;
    let ids = Object.keys(prod)
      .filter(idValido)
      .map(normId)
      .filter(pid => {
        const ue = prod[pid] && prod[pid].ultEnt;
        return ue && new Date(ue).getTime() >= limiteEntrada;
      });
    if (!ids.length) { alert('Nenhum produto válido com entrada nos últimos 12 meses.'); return null; }

    setBtn('⏳ Descrições...');
    const descMap = {};
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90);
      try {
        const arr = await apiGet('/api/v1/produto/produtos?q=id=in=(' + chunk.join(',') + ')&count=200');
        (arr.items || arr).forEach(p => {
          descMap[String(p.id)] = (p.descricao || p.descricaoReduzida || ('Produto ' + p.id)).trim();
        });
      } catch (e) {}
    }
    const nomeProduto = pid => descMap[String(pid)] || ('SEM CADASTRO (' + pid + ')');

    setBtn('⏳ Estoque...');
    const saldoMap = {};
    for (let i = 0; i < ids.length; i += 60) {
      const chunk = ids.slice(i, i + 60);
      try {
        const r = await apiGet(`/api/v1/estoque/saldos?q=produtoId=in=(${chunk.join(',')});${lojaFiltro}&count=1000`);
        (r.items || []).forEach(x => { saldoMap[x.produtoId] = (saldoMap[x.produtoId] || 0) + (x.saldo || 0); });
      } catch (e) {}
    }

    const dJanela = new Date(Date.now() - JANELA_VENDAS * 86400000).toISOString().slice(0, 10);
    const dt4m = new Date(Date.now() - DIAS_GIRO * 86400000).toISOString().slice(0, 10);

    // ===== Vendas em LOTE (v5.6): busca todos os produtos de uma vez, com paginacao =====
    setBtn('\u23f3 Vendas...');
    const vendasMap = {};
    ids.forEach(function (pid) { vendasMap[pid] = { vHist: 0, v4: 0 }; });
    const CHUNK_VENDAS = 50;
    for (let i = 0; i < ids.length; i += CHUNK_VENDAS) {
      const chunk = ids.slice(i, i + CHUNK_VENDAS);
      const setChunk = new Set(chunk);
      let start = 0;
      for (;;) {
        let pg;
        try {
          pg = await apiGet(`/api/v1/venda/cupons-fiscais?q=itensVenda.produtoId=in=(${chunk.join(',')});${lojaFiltro};data=ge=${dJanela}&count=500&start=${start}`);
        } catch (e) { break; }
        const items = pg.items || [];
        items.forEach(function (c) {
          const d = c.data;
          (c.itensVenda || []).forEach(function (iv) {
            if (setChunk.has(iv.produtoId) && vendasMap[iv.produtoId]) {
              const q = iv.quantidadeVenda || 0;
              vendasMap[iv.produtoId].vHist += q;
              if (d && d >= dt4m) vendasMap[iv.produtoId].v4 += q;
            }
          });
        });
        start += 500;
        if (start >= (pg.total || 0)) break;
      }
      setBtn('\u23f3 Vendas ' + Math.min(i + CHUNK_VENDAS, ids.length) + '/' + ids.length);
    }

    const linhas = await emLotes(ids, async (pid) => {
      const p = prod[pid];
      const caixa = Math.max(1, mdcLista(p.qtds));
      const vm = vendasMap[pid] || { vHist: 0, v4: 0 };
      let vHist = vm.vHist, v4 = vm.v4, truncado = false;

      const saldoSys = saldoMap[pid] != null ? saldoMap[pid] : '';
      const estEstimado = truncado ? null : (p.totalEntrada - vHist);
      const vDia = v4 / DIAS_GIRO;

      let classe, alvo;
      if (v4 === 0) { classe = 'Parado'; alvo = 0; }
      else if (vDia >= 1) { classe = 'Alto giro'; alvo = 45; }
      else if (vDia >= 0.3) { classe = 'Giro médio'; alvo = 60; }
      else { classe = 'Giro baixo'; alvo = 90; }

      let caixas = 0, sugUnid = 0;
      if (v4 > 0) {
        caixas = Math.max(1, Math.ceil((vDia * alvo) / caixa));
        sugUnid = caixas * caixa;
      }

      let semaforo;
      if (estEstimado != null && vDia > 0) {
        const cob = estEstimado / vDia;
        if (cob <= 15) semaforo = '🔴';
        else if (cob <= 40) semaforo = '🟡';
        else semaforo = '🟢';
      } else {
        const idade = diasDesde(p.ultEnt);
        semaforo = idade > 180 ? '🔴' : (idade > 90 ? '🟡' : '🟢');
      }

      const alertas = [];
      const idadeEnt = diasDesde(p.ultEnt);
      if (idadeEnt > 180) alertas.push('🔴 sem entrada >6m');
      if (v4 === 0) alertas.push('🟠 parado (sem venda 4m)');
      if (estEstimado != null && estEstimado < 0) alertas.push('⚠️ estimado negativo');
      if (truncado) alertas.push('⏳ estimativa indisponível (giro alto)');

      let pctVend = '';
      if (p.totalEntrada > 0) {
        const pct = (vHist / p.totalEntrada) * 100;
        pctVend = pct >= 100 ? '100% (Esgotou)' : Math.round(pct) + '%';
      }

      return {
        _urg: semaforo === '🔴' ? 0 : (semaforo === '🟡' ? 1 : 2),
        _v4: v4,
        linha: {
          'Sinal': semaforo,
          'Produto': nomeProduto(pid),
          'Classe de giro': classe,
          'Caixa (un)': caixa,
          'Sugestão (cx)': caixas || '',
          'Sugestão (un)': sugUnid || '',
          'Estoque Estimado (fluxo 13m)': estEstimado != null ? estEstimado : 's/ estimativa',
          'Estoque Real (sistema)': saldoSys,
          'Total Comprado (hist.)': p.totalEntrada,
          'Vendido (13m)': vHist,
          'Vendido (4m)': v4,
          '% Vendido': pctVend,
          'Últ. entrada': p.ultEnt ? p.ultEnt.slice(0, 10) : '',
          'Qtd últ. entrada': p.qtdUltEnt,
          'Alertas': alertas.join(' | '),
          'Cód. Barras': String(pid)
        }
      };
    }, POOL, 'Calculando');

    linhas.sort((a, b) => a._urg - b._urg || b._v4 - a._v4);
    return linhas.map(l => l.linha);
  }

  function exportarExcel(linhas, nomeArq) {
    const ws = XLSX.utils.json_to_sheet(linhas);
    const range = XLSX.utils.decode_range(ws['!ref']);
    let colBarras = -1;
    for (let C = range.s.c; C <= range.e.c; C++) {
      const cell = ws[XLSX.utils.encode_cell({ r: 0, c: C })];
      if (cell && cell.v === 'Cód. Barras') { colBarras = C; break; }
    }
    if (colBarras >= 0) {
      for (let R = range.s.r + 1; R <= range.e.r; R++) {
        const ref = XLSX.utils.encode_cell({ r: R, c: colBarras });
        const cell = ws[ref];
        if (cell && cell.v != null && cell.v !== '') {
          cell.t = 's';
          cell.v = String(cell.v);
          cell.z = '@';
          delete cell.w;
        }
      }
    }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sugestão de Compra');
    XLSX.writeFile(wb, nomeArq);
  }

  function criarBotao() {
    if (document.getElementById('vf-agente-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'vf-agente-btn';
    btn.textContent = '🛒 Agente de Compras';
    Object.assign(btn.style, {
      position: 'fixed', bottom: '74px', right: '24px', zIndex: 99999,
      background: '#2e7d32', color: '#fff', border: 'none', borderRadius: '6px',
      padding: '12px 16px', fontWeight: 'bold', cursor: 'pointer',
      boxShadow: '0 2px 8px rgba(0,0,0,.3)'
    });
    btn.onclick = abrirDialogo;
    document.body.appendChild(btn);
  }

  async function abrirDialogo() {
    // ----- Verificacao de licenca (email + trial 7d) -----
    var __liberado = await checarAcesso();
    if (!__liberado) return;


    const nome = prompt('Nome do fornecedor:');
    if (!nome) return;
    let forn;
    try {
      const termo = nome.trim().toUpperCase();
      const res = await apiGet('/api/v1/pessoa/fornecedores?q=nome==*' + encodeURIComponent(termo) + '*&count=10');
      const arr = res.items || [];
      if (!arr.length) { alert('Fornecedor não encontrado.'); return; }
      if (arr.length > 1) {
        const opcoes = arr.map((f, i) => (i + 1) + ') ' + f.nome).join('\n');
        const esc = prompt('Vários fornecedores encontrados:\n' + opcoes + '\n\nDigite o número:', '1');
        const ix = parseInt(esc, 10) - 1;
        if (isNaN(ix) || !arr[ix]) { alert('Opção inválida.'); return; }
        forn = arr[ix];
      } else { forn = arr[0]; }
    } catch (e) { alert('Erro ao buscar fornecedor: ' + e); return; }

    let lojas = [];
        try {
                const rl = await apiGet('/api/v1/pessoa/lojas?count=200');
                lojas = (rl.items || []).filter(function (x) { return x.ativo === true; }).map(function (x) { return { id: x.id, nome: x.nome || ('Loja ' + x.id), sigla: x.sigla || '' }; });        } catch (e) { alert('Erro ao buscar lojas: ' + e); return; }
        if (!lojas.length) { alert('Nenhuma loja encontrada nesta conta.'); return; }
        let lojaFiltro, sufixo;
        if (lojas.length === 1) {
                lojaFiltro = 'lojaId==' + lojas[0].id;
                sufixo = lojas[0].sigla || lojas[0].nome;
        } else {
                const opcoesLoja = lojas.map(function (l, i) { return (i + 1) + ') ' + l.nome + (l.sigla ? ' (' + l.sigla + ')' : ''); }).join('\n');
                const escL = prompt('Selecione a loja:\n' + opcoesLoja + '\nA) Todas (consolidado)\n\nDigite o numero ou A:', 'A');
                if (!escL) return;
                const oL = escL.trim().toUpperCase();
                if (oL === 'A') {
                          lojaFiltro = 'lojaId=in=(' + lojas.map(function (l) { return l.id; }).join(',') + ')';
                          sufixo = 'Todas';
                } else {
                          const ixL = parseInt(oL, 10) - 1;
                          if (isNaN(ixL) || !lojas[ixL]) { alert('Opcao invalida.'); return; }
                          lojaFiltro = 'lojaId==' + lojas[ixL].id;
                          sufixo = lojas[ixL].sigla || lojas[ixL].nome;
                }
        }

    const btn = document.getElementById('vf-agente-btn');
    btn.disabled = true;
    try {
      const linhas = await rodarAgente(forn.id, lojaFiltro);
      if (linhas && linhas.length) {
        exportarExcel(linhas, `AgenteCompras_${(forn.nome || nome).replace(/W+/g, '')}_${sufixo}.xlsx`);
      }
    } catch (e) {
      alert('Erro ao rodar o agente: ' + e);
    } finally {
      setBtn('🛒 Agente de Compras');
      btn.disabled = false;
    }
  }

  const obs = new MutationObserver(() => criarBotao());
  obs.observe(document.body, { childList: true, subtree: true });
  criarBotao();
})();
