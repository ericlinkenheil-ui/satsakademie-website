/* ---------- SatsAkademie: gemeinsame Navigation (Verhalten) ----------
   Eingebunden auf allen 7 Seiten via <script src="assets/nav.js" defer></script>.
   Enthält: (1) Hamburger-Menü-Toggle für Mobile, (2) "Neu"-Punkt neben "News"
   in der Nav, der automatisch aus news.html gelesen wird.
   Stand: 17.09.2026 (ausgelagert aus den 7 einzelnen Seiten, siehe
   knotenpunkt-website-fahrplan.md, Abschnitt "Arbeitsweise für künftige
   Website-Änderungen"). Künftige Änderungen am Nav-Verhalten bitte NUR hier
   vornehmen, nicht mehr in den einzelnen Seiten. */

(function () {
  var toggle = document.getElementById('nav-toggle');
  var links = document.getElementById('nav-links');
  if (!toggle || !links) return;
  function closeMenu() {
    links.classList.remove('open');
    toggle.setAttribute('aria-expanded', 'false');
  }
  toggle.addEventListener('click', function () {
    var isOpen = links.classList.toggle('open');
    toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  });
  links.querySelectorAll('a').forEach(function (a) {
    a.addEventListener('click', closeMenu);
  });
  document.addEventListener('click', function (e) {
    if (!links.classList.contains('open')) return;
    if (links.contains(e.target) || toggle.contains(e.target)) return;
    closeMenu();
  });
  window.addEventListener('resize', function () {
    if (window.innerWidth > 760) closeMenu();
  });
})();

(function () {
  // Aktuellstes Datum wird dynamisch aus news.html gelesen (data-date-Attribut
  // am ersten <article class="news-item">) — keine manuelle Pflege nötig.
  var STORAGE_KEY = "sats_last_seen_news";
  var dot = document.getElementById("news-dot");
  var newsLink = document.getElementById("nav-news-link");
  if (!dot) return;

  function showDotIfNew(latestDate) {
    if (!latestDate) return;
    try {
      var lastSeen = window.localStorage.getItem(STORAGE_KEY);
      if (!lastSeen || lastSeen < latestDate) {
        dot.classList.add("is-visible");
      }
    } catch (e) {
      // localStorage nicht verfügbar (z. B. privates Fenster) — Punkt einfach nicht anzeigen.
    }
    if (newsLink) {
      newsLink.addEventListener("click", function () {
        try { window.localStorage.setItem(STORAGE_KEY, latestDate); } catch (e) {}
      });
    }
  }

  try {
    fetch("news.html")
      .then(function (res) { return res.ok ? res.text() : null; })
      .then(function (html) {
        if (!html) return;
        var match = html.match(/class="news-item"\s+data-date="(\d{4}-\d{2}-\d{2})"/);
        if (match) showDotIfNew(match[1]);
      })
      .catch(function () {
        // Cross-Origin (z. B. Artifact-Vorschau) oder Netzwerkfehler — Punkt bleibt einfach aus.
      });
  } catch (e) {
    // fetch nicht verfügbar — Punkt bleibt einfach aus.
  }
})();
