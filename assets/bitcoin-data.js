/* ---------- SatsAkademie: Bitcoin-Live-Daten (gemeinsame Datenschicht) ----------
   Eingebunden auf der Startseite (Chart-Widget) und auf bitcoin-live-infos.html
   (vollständiges Dashboard) via <script src="assets/bitcoin-data.js" defer></script>.

   Prinzip: rein client-seitig, keine eigenen API-Keys, keine Server-Komponente –
   jeder Aufruf passiert direkt im Browser der Besucherin/des Besuchers gegen
   öffentliche, kostenlose APIs (siehe Quellen unten). Alle Abrufe sind defensiv:
   schlägt eine Quelle fehl (Netzwerk, Rate-Limit, CORS), zeigt das jeweilige
   Widget "Daten vorübergehend nicht verfügbar" statt die ganze Seite zu stören.

   Quellen:
   - Preis + Kursverlauf: CoinGecko Public API (api.coingecko.com), kein Key nötig.
   - Gebühren + Difficulty + Blockhöhe + Hashrate: mempool.space Public API.
     Fallback für Gebühren + Blockhöhe: blockstream.info Esplora API (dieselbe
     Datenbasis, unabhängiger Anbieter) – falls mempool.space nicht erreichbar ist.
     Zusätzlicher zweiter Fallback für Blockhöhe + Hashrate + Difficulty (seit
     19.09.2026, Fortsetzung 3): blockchain.info "Simple Query API"
     (blockchain.info/q/...), da mempool.space in der Praxis öfter mal für
     einzelne Besucher/IP-Bereiche 503 liefert (Cloudflare-Bot-Schutz) und
     Difficulty/Hashrate bis dahin gar keinen Fallback hatten. Die
     Difficulty-Fortschrittsanzeige wird in diesem Fall rein rechnerisch aus
     der Blockhöhe geschätzt (kein exaktes "erwartete Änderung"-Prozent
     verfügbar, siehe fetchDifficulty).
   - Fear & Greed Index: alternative.me Crypto Fear & Greed Index API.

   Stand: 19.09.2026 (siehe knotenpunkt-website-fahrplan.md, Abschnitt
   "Bitcoin Live Infos"). Künftige Änderungen an den Datenquellen bitte NUR hier
   vornehmen, nicht in den einzelnen Seiten. */

(function (global) {
  "use strict";

  var CACHE_PREFIX = "sats_live_";

  function readCache(key, maxAgeMs) {
    try {
      var raw = window.sessionStorage.getItem(CACHE_PREFIX + key);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.t !== "number") return null;
      if (Date.now() - parsed.t > maxAgeMs) return null;
      return parsed.v;
    } catch (e) {
      return null;
    }
  }

  function writeCache(key, value) {
    try {
      window.sessionStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ t: Date.now(), v: value }));
    } catch (e) {
      /* sessionStorage nicht verfügbar (z. B. privates Fenster) – einfach ohne Cache weiter */
    }
  }

  function fetchWithTimeout(url, timeoutMs) {
    var controller = ("AbortController" in window) ? new AbortController() : null;
    var timer = null;
    var opts = {};
    if (controller) {
      opts.signal = controller.signal;
      timer = setTimeout(function () { controller.abort(); }, timeoutMs || 9000);
    }
    return fetch(url, opts).then(function (res) {
      if (timer) clearTimeout(timer);
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    }).catch(function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    });
  }

  function withCache(key, maxAgeMs, loader) {
    var cached = readCache(key, maxAgeMs);
    if (cached !== null) return Promise.resolve(cached);
    return loader().then(function (value) {
      writeCache(key, value);
      return value;
    });
  }

  /* ---------- Preis (CoinGecko) ---------- */

  function fetchPrice() {
    return withCache("price", 45 * 1000, function () {
      var url = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd,eur&include_24hr_change=true";
      return fetchWithTimeout(url, 9000).then(function (data) {
        var b = data && data.bitcoin;
        if (!b) throw new Error("Unerwartete Antwort");
        return {
          usd: b.usd,
          eur: b.eur,
          usd_change_24h: b.usd_24h_change,
          eur_change_24h: b.eur_24h_change
        };
      });
    });
  }

  /* days: 1 = 24h (stündlich), 7/30 = täglich, 365 = wöchentlich (CoinGecko-Standardauflösung) */
  function fetchChart(currency, days) {
    var key = "chart_" + currency + "_" + days;
    return withCache(key, 5 * 60 * 1000, function () {
      var url = "https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=" + currency + "&days=" + days;
      return fetchWithTimeout(url, 12000).then(function (data) {
        if (!data || !Array.isArray(data.prices)) throw new Error("Unerwartete Antwort");
        return data.prices; // [[timestamp_ms, price], ...]
      });
    });
  }

  /* ---------- Gebühren (mempool.space, Fallback blockstream.info) ---------- */

  function fetchFees() {
    return withCache("fees", 60 * 1000, function () {
      return fetchWithTimeout("https://mempool.space/api/v1/fees/recommended", 9000).then(function (d) {
        return {
          source: "mempool.space",
          fastest: d.fastestFee,
          halfHour: d.halfHourFee,
          hour: d.hourFee,
          economy: d.economyFee,
          minimum: d.minimumFee
        };
      }).catch(function () {
        return fetchWithTimeout("https://blockstream.info/api/fee-estimates", 9000).then(function (d) {
          return {
            source: "blockstream.info",
            fastest: Math.round(d["1"] || d["2"]),
            halfHour: Math.round(d["3"] || d["4"]),
            hour: Math.round(d["6"] || d["8"]),
            economy: Math.round(d["144"] || d["504"] || d["1008"])
          };
        });
      });
    });
  }

  var DIFFICULTY_EPOCH_BLOCKS = 2016;

  /* Rein rechnerische Schätzung, falls mempool.space nicht erreichbar ist:
     liefert dieselben Felder wie die mempool.space-Antwort, aber ohne
     "difficultyChange" (dafür bräuchte man die historischen Blockzeiten
     der laufenden Periode, die blockchain.info/blockstream.info so nicht
     hergeben) – die Oberfläche blendet das Feld in diesem Fall aus. */
  function estimateDifficultyFromHeight(height) {
    var intoEpoch = height % DIFFICULTY_EPOCH_BLOCKS;
    var remainingBlocks = DIFFICULTY_EPOCH_BLOCKS - intoEpoch;
    var progressPercent = (intoEpoch / DIFFICULTY_EPOCH_BLOCKS) * 100;
    var estimatedRetargetDate = new Date(Date.now() + remainingBlocks * AVG_BLOCK_SECONDS * 1000).toISOString();
    return {
      progressPercent: progressPercent,
      remainingBlocks: remainingBlocks,
      difficultyChange: null,
      estimatedRetargetDate: estimatedRetargetDate,
      estimated: true
    };
  }

  /* ---------- Difficulty-Adjustment (mempool.space, Fallback: rechnerische
     Schätzung aus der Blockhöhe, siehe estimateDifficultyFromHeight) ---------- */

  function fetchDifficulty() {
    return withCache("difficulty", 5 * 60 * 1000, function () {
      return fetchWithTimeout("https://mempool.space/api/v1/difficulty-adjustment", 9000).catch(function () {
        return fetchBlockHeight().then(estimateDifficultyFromHeight);
      });
    });
  }

  /* ---------- Blockhöhe (mempool.space, Fallback blockstream.info, dann blockchain.info) ---------- */

  function fetchHeightFrom(url, parse, timeoutMs) {
    var controller = ("AbortController" in window) ? new AbortController() : null;
    var timer = null;
    var opts = {};
    if (controller) {
      opts.signal = controller.signal;
      timer = setTimeout(function () { controller.abort(); }, timeoutMs || 6000);
    }
    return fetch(url, opts).then(function (res) {
      if (timer) clearTimeout(timer);
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.text();
    }).then(parse || function (t) { return parseInt(t, 10); }).catch(function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    });
  }

  function fetchBlockHeight() {
    return withCache("height", 60 * 1000, function () {
      return fetchHeightFrom("https://mempool.space/api/blocks/tip/height")
        .catch(function () {
          return fetchHeightFrom("https://blockstream.info/api/blocks/tip/height");
        })
        .catch(function () {
          return fetchHeightFrom("https://blockchain.info/q/getblockcount?cors=true");
        });
    });
  }

  /* ---------- Netzwerk-Hashrate (mempool.space, Fallback blockchain.info) ---------- */

  function fetchHashrate() {
    return withCache("hashrate", 5 * 60 * 1000, function () {
      return fetchWithTimeout("https://mempool.space/api/v1/mining/hashrate/1m", 9000).then(function (d) {
        if (!d || typeof d.currentHashrate !== "number") throw new Error("Unerwartete Antwort");
        return d.currentHashrate; // Hash/s
      }).catch(function () {
        /* blockchain.info liefert GH/s (24h-Schätzung) als reinen Zahlentext */
        return fetch("https://blockchain.info/q/hashrate?cors=true").then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.text();
        }).then(function (t) {
          var ghs = parseFloat(t);
          if (isNaN(ghs)) throw new Error("Unerwartete Antwort");
          return ghs * 1e9; // GH/s -> Hash/s
        });
      });
    });
  }

  /* ---------- Fear & Greed Index (alternative.me) ---------- */

  function fetchFearGreed() {
    return withCache("feargreed", 30 * 60 * 1000, function () {
      return fetchWithTimeout("https://api.alternative.me/fng/?limit=1", 9000).then(function (d) {
        var entry = d && d.data && d.data[0];
        if (!entry) throw new Error("Unerwartete Antwort");
        return { value: parseInt(entry.value, 10), classification: entry.value_classification };
      });
    });
  }

  /* ---------- Halving-Countdown (rein rechnerisch aus der Blockhöhe) ---------- */

  var BLOCKS_PER_HALVING = 210000;
  var AVG_BLOCK_SECONDS = 600; // 10 Minuten Zielwert des Bitcoin-Protokolls

  function halvingInfo(height) {
    var epoch = Math.floor(height / BLOCKS_PER_HALVING);
    var nextHeight = (epoch + 1) * BLOCKS_PER_HALVING;
    var blocksRemaining = nextHeight - height;
    var estSeconds = blocksRemaining * AVG_BLOCK_SECONDS;
    var estDate = new Date(Date.now() + estSeconds * 1000);
    return {
      nextHeight: nextHeight,
      blocksRemaining: blocksRemaining,
      currentReward: 50 / Math.pow(2, epoch),
      nextReward: 50 / Math.pow(2, epoch + 1),
      estDate: estDate
    };
  }

  /* ---------- Formatierungs-Helfer ---------- */

  function formatMoney(value, currency) {
    if (typeof value !== "number" || isNaN(value)) return "–";
    var locale = "de-DE";
    var opts = { style: "currency", currency: currency.toUpperCase(), maximumFractionDigits: value >= 1000 ? 0 : 2 };
    try {
      return new Intl.NumberFormat(locale, opts).format(value);
    } catch (e) {
      return value.toFixed(0) + " " + currency.toUpperCase();
    }
  }

  function formatPercent(value) {
    if (typeof value !== "number" || isNaN(value)) return "–";
    var sign = value > 0 ? "+" : "";
    return sign + value.toFixed(2).replace(".", ",") + " %";
  }

  function formatHashrate(hashPerSec) {
    if (typeof hashPerSec !== "number" || isNaN(hashPerSec)) return "–";
    var eh = hashPerSec / 1e18;
    return eh.toLocaleString("de-DE", { maximumFractionDigits: 1 }) + " EH/s";
  }

  function formatNumber(value) {
    if (typeof value !== "number" || isNaN(value)) return "–";
    return value.toLocaleString("de-DE");
  }

  function formatDuration(seconds) {
    var days = Math.floor(seconds / 86400);
    if (days >= 1) return days + (days === 1 ? " Tag" : " Tage");
    var hours = Math.floor(seconds / 3600);
    return hours + (hours === 1 ? " Stunde" : " Stunden");
  }

  /* ---------- Wiederverwendbares Preis+Chart-Widget ----------
     Wird auf der Startseite UND auf bitcoin-live-infos.html mit denselben
     Regeln verwendet (nur andere Element-IDs) – so bleibt das Verhalten
     garantiert identisch. Benötigt Chart.js (global `Chart`) vor dem Aufruf. */

  function mountPriceChart(cfg) {
    var state = { currency: cfg.defaultCurrency || "eur", days: cfg.defaultDays || 7 };
    var chartInstance = null;

    function setActive(buttons, datasetKey, value) {
      if (!buttons) return;
      for (var i = 0; i < buttons.length; i++) {
        var btn = buttons[i];
        var isActive = btn.getAttribute("data-" + datasetKey) === String(value);
        btn.classList.toggle("is-active", isActive);
      }
    }

    function formatLabel(ts, days) {
      var d = new Date(ts);
      if (days <= 1) {
        return d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
      }
      return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
    }

    function renderTicker(data) {
      if (!cfg.priceEl) return;
      var price = state.currency === "eur" ? data.eur : data.usd;
      var change = state.currency === "eur" ? data.eur_change_24h : data.usd_change_24h;
      cfg.priceEl.textContent = formatMoney(price, state.currency);
      cfg.priceEl.classList.remove("is-loading");
      if (cfg.changeEl) {
        cfg.changeEl.textContent = formatPercent(change) + " (24h)";
        cfg.changeEl.classList.remove("is-up", "is-down");
        cfg.changeEl.classList.add(change >= 0 ? "is-up" : "is-down");
      }
      if (cfg.updatedEl) {
        cfg.updatedEl.textContent = "Stand: " + new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
      }
    }

    function updateTicker() {
      fetchPrice().then(renderTicker).catch(function () {
        if (cfg.priceEl) {
          cfg.priceEl.textContent = "Kurs vorübergehend nicht verfügbar";
          cfg.priceEl.classList.add("is-loading");
        }
      });
    }

    function setChartStatus(text) {
      if (!cfg.chartStatusEl) return;
      if (text) {
        cfg.chartStatusEl.textContent = text;
        cfg.chartStatusEl.classList.add("is-visible");
      } else {
        cfg.chartStatusEl.classList.remove("is-visible");
      }
    }

    function updateChart(attempt) {
      if (!cfg.canvas) return;
      if (!global.Chart) {
        attempt = attempt || 0;
        if (attempt > 60) {
          setChartStatus("Chart-Bibliothek konnte nicht geladen werden.");
          return;
        }
        setChartStatus("Chart wird geladen …");
        window.setTimeout(function () { updateChart(attempt + 1); }, 150);
        return;
      }
      setChartStatus("Chart wird geladen …");
      fetchChart(state.currency, state.days).then(function (points) {
        setChartStatus(null);
        var labels = points.map(function (p) { return formatLabel(p[0], state.days); });
        var values = points.map(function (p) { return p[1]; });
        if (chartInstance) {
          chartInstance.data.labels = labels;
          chartInstance.data.datasets[0].data = values;
          chartInstance.data.datasets[0].label = "BTC/" + state.currency.toUpperCase();
          chartInstance.update();
          return;
        }
        chartInstance = new Chart(cfg.canvas.getContext("2d"), {
          type: "line",
          data: {
            labels: labels,
            datasets: [{
              label: "BTC/" + state.currency.toUpperCase(),
              data: values,
              borderColor: "#f7931a",
              backgroundColor: "rgba(247, 147, 26, 0.12)",
              borderWidth: 2,
              pointRadius: 0,
              tension: 0.25,
              fill: true
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 300 },
            interaction: { mode: "index", intersect: false },
            plugins: {
              legend: { display: false },
              tooltip: {
                callbacks: {
                  label: function (ctx) { return formatMoney(ctx.parsed.y, state.currency); }
                }
              }
            },
            scales: {
              x: {
                grid: { color: "rgba(255,255,255,0.06)" },
                ticks: { color: "#8b93ab", maxTicksLimit: 7, font: { family: "IBM Plex Mono, monospace", size: 10 } }
              },
              y: {
                grid: { color: "rgba(255,255,255,0.06)" },
                ticks: {
                  color: "#8b93ab",
                  font: { family: "IBM Plex Mono, monospace", size: 10 },
                  callback: function (v) { return formatMoney(v, state.currency); }
                }
              }
            }
          }
        });
      }).catch(function () {
        setChartStatus("Chart-Daten vorübergehend nicht verfügbar.");
      });
    }

    if (cfg.currencyButtons) {
      for (var i = 0; i < cfg.currencyButtons.length; i++) {
        cfg.currencyButtons[i].addEventListener("click", function (e) {
          var val = e.currentTarget.getAttribute("data-currency");
          if (val === state.currency) return;
          state.currency = val;
          setActive(cfg.currencyButtons, "currency", val);
          updateTicker();
          updateChart();
        });
      }
    }
    if (cfg.rangeButtons) {
      for (var j = 0; j < cfg.rangeButtons.length; j++) {
        cfg.rangeButtons[j].addEventListener("click", function (e) {
          var val = parseInt(e.currentTarget.getAttribute("data-days"), 10);
          if (val === state.days) return;
          state.days = val;
          setActive(cfg.rangeButtons, "days", val);
          updateChart();
        });
      }
    }

    setActive(cfg.currencyButtons, "currency", state.currency);
    setActive(cfg.rangeButtons, "days", state.days);
    updateTicker();
    updateChart();
    setInterval(updateTicker, 60 * 1000);
    setInterval(updateChart, 5 * 60 * 1000);
  }

  global.SatsLive = {
    fetchPrice: fetchPrice,
    fetchChart: fetchChart,
    fetchFees: fetchFees,
    fetchDifficulty: fetchDifficulty,
    fetchBlockHeight: fetchBlockHeight,
    fetchHashrate: fetchHashrate,
    fetchFearGreed: fetchFearGreed,
    halvingInfo: halvingInfo,
    formatMoney: formatMoney,
    formatPercent: formatPercent,
    formatHashrate: formatHashrate,
    formatNumber: formatNumber,
    formatDuration: formatDuration,
    mountPriceChart: mountPriceChart
  };
})(window);
