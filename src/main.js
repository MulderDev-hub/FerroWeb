/**
 * FerroWeb – Frontend-Logik
 *
 * Zuständig für:
 *  - Navigation zwischen Views (Dashboard, SEO Audit, Assets, Einstellungen)
 *  - Ordnerauswahl via Tauri Dialog API
 *  - Darstellung der Scan-Ergebnisse (Metriken, Probleme-Liste)
 *  - Animierter Health-Score-Donut
 */

// ── Tauri API ────────────────────────────────────────────────
// window.__TAURI__ wird durch "withGlobalTauri: true" in tauri.conf.json
// automatisch injiziert – kein npm-Import nötig.
const { invoke }            = window.__TAURI__.core;
const { open: openDialog }  = window.__TAURI__.dialog;

// ── App-Zustand ───────────────────────────────────────────────
const state = {
  projectPath:   null,   // Aktuell geöffneter Ordnerpfad
  scanResults:   null,   // Ergebnisse vom letzten Rust-Scan
  activeView:    'dashboard',
  activeFilter:  'all',  // Issue-Filter: 'all' | 'error' | 'warning' | 'info'
};

// ── DOM-Referenzen ────────────────────────────────────────────
const els = {
  navItems:          document.querySelectorAll('.nav-item'),
  views:             document.querySelectorAll('.view'),
  pageTitle:         document.getElementById('page-title'),
  btnOpenFolder:     document.getElementById('btn-open-folder'),
  btnOpenFolderEmpty:document.getElementById('btn-open-folder-empty'),
  btnRescan:         document.getElementById('btn-rescan'),
  emptyState:        document.getElementById('empty-state'),
  dashboardContent:  document.getElementById('dashboard-content'),
  projectPathDisplay:document.getElementById('project-path-display'),
  projectMeta:       document.getElementById('project-meta'),
  projectNameSidebar:document.getElementById('project-name-sidebar'),
  gaugeRing:         document.getElementById('gauge-ring'),
  gaugeScoreText:    document.getElementById('gauge-score-text'),
  seoCount:          document.getElementById('seo-count'),
  seoErrors:         document.getElementById('seo-errors'),
  seoWarnings:       document.getElementById('seo-warnings'),
  badgeSeo:          document.getElementById('badge-seo'),
  assetCount:        document.getElementById('asset-count'),
  assetLarge:        document.getElementById('asset-large'),
  assetMissingAlt:   document.getElementById('asset-missing-alt'),
  badgeAssets:       document.getElementById('badge-assets'),
  pagesCount:        document.getElementById('pages-count'),
  pagesOk:           document.getElementById('pages-ok'),
  pagesIssues:       document.getElementById('pages-issues'),
  issuesList:        document.getElementById('issues-list'),
  filterBtns:        document.querySelectorAll('.filter-btn'),
};

// ─────────────────────────────────────────────────────────────
// NAVIGATION
// ─────────────────────────────────────────────────────────────

/**
 * Wechselt zur angegebenen View und aktualisiert die Sidebar-Navigation.
 * @param {string} viewName - ID-Suffix der Ziel-View (z.B. 'dashboard')
 */
function switchView(viewName) {
  state.activeView = viewName;

  // Alle Nav-Items deaktivieren, dann das passende aktivieren
  els.navItems.forEach(item => {
    item.classList.toggle('active', item.dataset.view === viewName);
  });

  // Alle Views ausblenden, dann die Ziel-View einblenden
  els.views.forEach(view => {
    view.classList.toggle('active', view.id === `view-${viewName}`);
  });

  // Seiten-Titel in der Topbar aktualisieren
  const titles = {
    'dashboard':  'Dashboard',
    'seo-audit':  'SEO Audit',
    'assets':     'Asset Manager',
    'settings':   'Einstellungen',
  };
  els.pageTitle.textContent = titles[viewName] ?? viewName;
}

// Klick-Events für alle Sidebar-Links registrieren
els.navItems.forEach(item => {
  item.addEventListener('click', e => {
    e.preventDefault();
    switchView(item.dataset.view);
    if (state.scanResults) {
      if (item.dataset.view === 'seo-audit')  renderSeoAudit(state.scanResults);
      if (item.dataset.view === 'assets')     renderAssetManager(state.scanResults);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// ORDNER ÖFFNEN
// ─────────────────────────────────────────────────────────────

/**
 * Öffnet den nativen Ordner-Auswahl-Dialog (Tauri Plugin: dialog).
 * Nach erfolgreicher Auswahl wird automatisch ein Scan gestartet.
 */
async function openFolder() {
  try {
    const path = await openDialog({
      directory: true,
      multiple:  false,
      title:     'Projektordner auswählen',
    });

    // Benutzer hat abgebrochen → nichts tun
    if (!path) return;

    state.projectPath = path;
    await runScan(path);
  } catch (err) {
    console.error('Fehler beim Öffnen des Dialogs:', err);
  }
}

// Beide "Ordner öffnen"-Buttons verknüpfen
els.btnOpenFolder.addEventListener('click', openFolder);
els.btnOpenFolderEmpty.addEventListener('click', openFolder);

// "Neu scannen"-Button
els.btnRescan.addEventListener('click', () => {
  if (state.projectPath) runScan(state.projectPath);
});

// ─────────────────────────────────────────────────────────────
// SCAN (Rust-Backend aufrufen)
// ─────────────────────────────────────────────────────────────

/**
 * Ruft den Rust-Befehl "scan_project" auf und rendert das Ergebnis.
 * Solange der Befehl noch nicht implementiert ist, werden Demo-Daten verwendet.
 * @param {string} path - Absoluter Pfad zum Projektordner
 */
async function runScan(path) {
  // UI auf "Lädt"-Zustand setzen
  showDashboardContent(path);
  els.projectMeta.textContent = 'Scannt…';

  try {
    // Rust-Kommando aufrufen (wird in src-tauri/src/lib.rs definiert)
    const results = await invoke('scan_project', { path });
    renderDashboard(results);
  } catch (_err) {
    // Scan-Befehl noch nicht implementiert → Demo-Daten zeigen
    renderDashboard(getDemoData(path));
  }

  // Live-Vorschau starten (parallel zum Scan)
  startLivePreview(path).catch(err => console.error('Preview-Server Fehler:', err));
}

/**
 * Blendet den Leer-Zustand aus und zeigt den Dashboard-Inhalt mit dem
 * gewählten Pfad an.
 * @param {string} path
 */
function showDashboardContent(path) {
  els.emptyState.classList.add('hidden');
  els.dashboardContent.classList.remove('hidden');

  // Pfad anzeigen (langen Pfad verkürzen für die Anzeige)
  els.projectPathDisplay.textContent = path;

  // Projektname in der Sidebar (nur letzter Ordner-Name)
  const folderName = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  els.projectNameSidebar.textContent = folderName;
}

// ─────────────────────────────────────────────────────────────
// DASHBOARD RENDERN
// ─────────────────────────────────────────────────────────────

/**
 * Befüllt alle Metrikkarten und die Probleme-Liste mit den Scan-Ergebnissen.
 * @param {object} data - Scan-Ergebnisobjekt (von Rust oder Demo)
 */
function renderDashboard(data) {
  state.scanResults = data;

  // Meta-Zeile
  els.projectMeta.textContent =
    `${data.totalPages} Seite(n) gescannt · Letzter Scan: gerade eben`;

  // ── Metrikkarten befüllen ──

  // Health Score animieren (0 → Zielwert)
  animateScore(data.healthScore);

  // SEO-Probleme
  const seoTotal = data.seoErrors + data.seoWarnings;
  els.seoCount.textContent    = seoTotal;
  els.seoErrors.textContent   = `${data.seoErrors} Fehler`;
  els.seoWarnings.textContent = `${data.seoWarnings} Warnungen`;
  els.badgeSeo.textContent    = seoTotal;

  // Asset-Probleme
  const assetTotal = data.largeImages + data.missingAlt;
  els.assetCount.textContent      = assetTotal;
  els.assetLarge.textContent      = `${data.largeImages} zu groß (>500 KB)`;
  els.assetMissingAlt.textContent = `${data.missingAlt} fehlendes Alt-Attribut`;
  els.badgeAssets.textContent     = assetTotal;

  // Seiten-Statistiken
  const pagesWithIssues = data.totalPages - data.cleanPages;
  els.pagesCount.textContent  = data.totalPages;
  els.pagesOk.textContent     = `${data.cleanPages} problemlos`;
  els.pagesIssues.textContent = `${pagesWithIssues} mit Problemen`;

  // ── Probleme-Liste rendern ──
  renderIssues(data.issues, state.activeFilter);

  // Andere Views direkt mitaktualisieren falls gerade aktiv
  if (state.activeView === 'seo-audit') renderSeoAudit(data);
  if (state.activeView === 'assets')    renderAssetManager(data);
}

// ─────────────────────────────────────────────────────────────
// PROBLEME-LISTE
// ─────────────────────────────────────────────────────────────

/**
 * Rendert die Issue-Liste. Filtert nach Schweregrad wenn nötig.
 * @param {Array}  issues  - Array von Issue-Objekten
 * @param {string} filter  - 'all' | 'error' | 'warning' | 'info'
 */
function renderIssues(issues, filter) {
  const filtered = filter === 'all'
    ? issues
    : issues.filter(issue => issue.severity === filter);

  if (filtered.length === 0) {
    // Leer-Zustand der Liste anzeigen
    els.issuesList.innerHTML = `
      <div class="no-issues">
        <svg viewBox="0 0 24 24" fill="none">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"
                stroke="currentColor" stroke-width="2"
                stroke-linecap="round" stroke-linejoin="round"/>
          <polyline points="22 4 12 14.01 9 11.01"
                    stroke="currentColor" stroke-width="2"
                    stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <p>${filter === 'all'
          ? 'Keine Probleme gefunden — alles sauber!'
          : `Keine ${filter === 'error' ? 'Fehler' : filter === 'warning' ? 'Warnungen' : 'Hinweise'} gefunden.`
        }</p>
      </div>`;
    return;
  }

  // SVG-Icons je Schweregrad
  const icons = {
    error: `<svg viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
              <line x1="12" y1="8" x2="12" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              <line x1="12" y1="16" x2="12.01" y2="16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>`,
    warning: `<svg viewBox="0 0 24 24" fill="none">
                <path d="m10.29 3.86-8.66 15A2 2 0 0 0 3.36 22h17.27a2 2 0 0 0 1.73-3l-8.64-15a2 2 0 0 0-3.46 0z"
                      stroke="currentColor" stroke-width="2"
                      stroke-linecap="round" stroke-linejoin="round"/>
                <line x1="12" y1="9" x2="12" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                <line x1="12" y1="17" x2="12.01" y2="17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              </svg>`,
    info: `<svg viewBox="0 0 24 24" fill="none">
             <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
             <line x1="12" y1="16" x2="12" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
             <line x1="12" y1="8" x2="12.01" y2="8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
           </svg>`,
  };

  els.issuesList.innerHTML = filtered.map(issue => `
    <div class="issue-item issue-${issue.severity}">
      <div class="issue-icon">${icons[issue.severity] ?? icons.info}</div>
      <div class="issue-body">
        <p class="issue-title">${escapeHtml(issue.title)}</p>
        <p class="issue-file">${escapeHtml(issue.file)}</p>
        ${issue.suggestion ? `
          <button class="issue-tip-btn" onclick="this.closest('.issue-item').classList.toggle('tip-open')">
            <svg viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
              <path d="M12 16v-4M12 8h.01" stroke="currentColor" stroke-width="2"
                    stroke-linecap="round"/>
            </svg>
            Wie beheben?
          </button>
          <div class="issue-tip">${escapeHtml(issue.suggestion)}</div>
        ` : ''}
      </div>
      <span class="issue-tag">${escapeHtml(issue.category)}</span>
    </div>
  `).join('');
}

// Filter-Button-Events registrieren
els.filterBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    // Aktiven Button wechseln
    els.filterBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    state.activeFilter = btn.dataset.filter;

    // Liste neu rendern wenn Scan-Ergebnisse vorhanden sind
    if (state.scanResults) {
      renderIssues(state.scanResults.issues, state.activeFilter);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// HEALTH SCORE – Donut-Animation
// ─────────────────────────────────────────────────────────────

/**
 * Animiert den SVG-Donut-Ring von 0 auf den Zielwert.
 * Kreis-Umfang bei r=50: 2 × π × 50 ≈ 314
 * stroke-dashoffset = Umfang × (1 - Score/100)
 * @param {number} targetScore - Ziel-Score (0–100)
 */
function animateScore(targetScore) {
  const circumference = 314; // 2 * π * 50, gerundet
  let current = 0;
  const increment = targetScore / 60; // 60 Animationsschritte

  const tick = () => {
    current = Math.min(current + increment, targetScore);
    const offset = circumference * (1 - current / 100);

    els.gaugeRing.style.strokeDashoffset = offset;
    els.gaugeRing.style.stroke           = getScoreColor(current);
    els.gaugeScoreText.textContent       = Math.round(current);

    if (current < targetScore) {
      requestAnimationFrame(tick);
    }
  };

  requestAnimationFrame(tick);
}

/**
 * Gibt die Farbe für einen Score-Wert zurück.
 * @param {number} score
 * @returns {string} CSS-Farbwert
 */
function getScoreColor(score) {
  if (score >= 90) return '#10b981'; // Grün  – sehr gut
  if (score >= 75) return '#22c55e'; // Hellgrün – gut
  if (score >= 60) return '#eab308'; // Gelb  – mittelmäßig
  if (score >= 40) return '#f97316'; // Orange – schlecht
  return '#ef4444';                  // Rot   – kritisch
}

// ─────────────────────────────────────────────────────────────
// SEO AUDIT VIEW
// ─────────────────────────────────────────────────────────────

/**
 * Rendert die SEO-Audit-Ansicht mit Per-Page-Accordion-Liste.
 * @param {object} data - Scan-Ergebnisse (aus state.scanResults)
 */
function renderSeoAudit(data) {
  const noProject   = document.getElementById('audit-no-project');
  const auditContent = document.getElementById('audit-content');

  // Kein-Projekt-Zustand ausblenden
  noProject.classList.add('hidden');
  auditContent.classList.remove('hidden');

  // ── Kennzahlen-Leiste befüllen ──
  const pagesWithErrors   = data.pages.filter(p => p.errorCount   > 0).length;
  const pagesWithWarnings = data.pages.filter(p => p.errorCount === 0 && p.warningCount > 0).length;
  const cleanPages        = data.pages.filter(p => p.errorCount === 0 && p.warningCount === 0 && p.infoCount === 0).length;

  document.getElementById('audit-total').textContent         = data.pages.length;
  document.getElementById('audit-with-errors').textContent   = pagesWithErrors;
  document.getElementById('audit-with-warnings').textContent = pagesWithWarnings;
  document.getElementById('audit-clean').textContent         = cleanPages;

  // ── Seiten-Liste rendern ──
  renderPageList(data, 'all');

  // ── Filter-Buttons verknüpfen ──
  document.querySelectorAll('#audit-filter-group .filter-btn').forEach(btn => {
    // Alten Listener entfernen (Klone vermeiden doppelte Events)
    const fresh = btn.cloneNode(true);
    btn.parentNode.replaceChild(fresh, btn);
    fresh.addEventListener('click', () => {
      document.querySelectorAll('#audit-filter-group .filter-btn')
        .forEach(b => b.classList.remove('active'));
      fresh.classList.add('active');
      renderPageList(data, fresh.dataset.pageFilter);
    });
  });
}

/**
 * Rendert die Accordion-Liste aller Seiten im SEO Audit.
 * @param {object} data       - Scan-Ergebnisse
 * @param {string} filter     - 'all' | 'errors' | 'warnings' | 'clean'
 */
function renderPageList(data, filter) {
  const list = document.getElementById('page-list');

  // Seiten nach Filter auswählen
  const filtered = data.pages.filter(page => {
    if (filter === 'errors')   return page.errorCount > 0;
    if (filter === 'warnings') return page.errorCount === 0 && page.warningCount > 0;
    if (filter === 'clean')    return page.errorCount === 0 && page.warningCount === 0 && page.infoCount === 0;
    return true;
  });

  if (filtered.length === 0) {
    list.innerHTML = `<div class="no-issues">
      <svg viewBox="0 0 24 24" fill="none">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" stroke="currentColor"
              stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <polyline points="22 4 12 14.01 9 11.01" stroke="currentColor"
                  stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <p>Keine Seiten für diesen Filter gefunden.</p>
    </div>`;
    return;
  }

  // Issues nach Dateipfad gruppieren für schnellen Zugriff
  const issuesByFile = {};
  (data.issues || []).forEach(issue => {
    if (!issuesByFile[issue.file]) issuesByFile[issue.file] = [];
    issuesByFile[issue.file].push(issue);
  });

  list.innerHTML = filtered.map(page => buildPageItem(page, issuesByFile)).join('');

  // Accordion-Klick-Events
  list.querySelectorAll('.page-item-header').forEach(header => {
    header.addEventListener('click', () => {
      const item = header.closest('.page-item');
      item.classList.toggle('expanded');
    });
  });
}

/**
 * Baut das HTML für einen einzelnen Accordion-Eintrag.
 * @param {object} page         - PageSummary von Rust
 * @param {object} issuesByFile - Issues gruppiert nach Dateiname
 * @returns {string} HTML-String
 */
function buildPageItem(page, issuesByFile) {
  // Status-Klasse und Badges bestimmen
  let statusClass = 'page-item--clean';
  let badges = '';

  if (page.errorCount > 0) {
    statusClass = 'page-item--error';
    badges += `<span class="badge badge-error-sm">${page.errorCount} Fehler</span>`;
  }
  if (page.warningCount > 0) {
    if (!page.errorCount) statusClass = 'page-item--warning';
    badges += `<span class="badge badge-warning-sm">${page.warningCount} Warnung${page.warningCount > 1 ? 'en' : ''}</span>`;
  }
  if (page.infoCount > 0) {
    if (!page.errorCount && !page.warningCount) statusClass = 'page-item--info';
    badges += `<span class="badge badge-info-sm">${page.infoCount} Hinweis${page.infoCount > 1 ? 'e' : ''}</span>`;
  }
  if (!page.errorCount && !page.warningCount && !page.infoCount) {
    badges = `<span class="badge badge-clean-sm">✓ Sauber</span>`;
  }

  // Meta-Infos (Titel, Description)
  const titleDisplay = page.title
    ? `<span class="page-meta-value">${escapeHtml(page.title)}</span>`
    : `<span class="page-meta-value missing">— nicht gesetzt —</span>`;

  const descDisplay = page.description
    ? `<span class="page-meta-value">${escapeHtml(page.description)}</span>`
    : `<span class="page-meta-value missing">— nicht gesetzt —</span>`;

  // Issue-Zeilen dieser Seite
  const pageIssues = issuesByFile[page.path] || [];
  const issueRows = pageIssues.map(issue => `
    <div class="page-issue-row" style="flex-direction:column;align-items:flex-start;gap:6px">
      <div style="display:flex;align-items:center;gap:8px;width:100%">
        <span class="issue-dot dot-${issue.severity}" style="flex-shrink:0"></span>
        <span class="issue-text" style="flex:1">${escapeHtml(issue.title)}</span>
        <span class="issue-cat">${escapeHtml(issue.category)}</span>
      </div>
      ${issue.suggestion ? `
        <div style="margin-left:15px;padding:7px 10px;border-radius:6px;
                    background:rgba(99,102,241,0.07);border-left:2px solid #6366f1;
                    font-size:12px;color:#94a3b8;line-height:1.6">
          <strong style="color:#818cf8;font-size:11px;text-transform:uppercase;
                         letter-spacing:0.4px;display:block;margin-bottom:3px">
            Wie beheben?
          </strong>
          ${escapeHtml(issue.suggestion)}
        </div>
      ` : ''}
    </div>
  `).join('');

  // Dateiname (nur letzter Teil für Lesbarkeit)
  const displayName = page.path.split('/').pop() || page.path;

  return `
    <div class="page-item ${statusClass}">
      <button class="page-item-header">
        <div class="page-item-left">
          <!-- Datei-Icon -->
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"
                  stroke="currentColor" stroke-width="2"
                  stroke-linecap="round" stroke-linejoin="round"/>
            <polyline points="14 2 14 8 20 8" stroke="currentColor"
                      stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span class="page-item-name" title="${escapeHtml(page.path)}">${escapeHtml(displayName)}</span>
          ${page.path !== displayName
            ? `<span style="font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px">${escapeHtml(page.path)}</span>`
            : ''}
        </div>
        <div class="page-item-right">
          ${badges}
          <!-- Chevron dreht sich beim Expand -->
          <svg class="page-chevron" viewBox="0 0 24 24" fill="none">
            <polyline points="6 9 12 15 18 9" stroke="currentColor"
                      stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
      </button>

      <div class="page-item-body">
        <div class="page-item-body-inner">

          <!-- Seiten-Metadaten -->
          <div class="page-meta-grid">
            <span class="page-meta-label">Titel</span>
            ${titleDisplay}
            <span class="page-meta-label">Description</span>
            ${descDisplay}
            <span class="page-meta-label">Pfad</span>
            <span class="page-meta-value" style="font-family:monospace">${escapeHtml(page.path)}</span>
          </div>

          <!-- Issue-Zeilen -->
          ${pageIssues.length > 0
            ? `<div class="page-issues">${issueRows}</div>`
            : `<p style="font-size:12px;color:var(--success)">✓ Keine Probleme gefunden</p>`
          }
        </div>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// ASSET MANAGER VIEW
// ─────────────────────────────────────────────────────────────

// SVG-Icons je Asset-Typ
const ASSET_ICONS = {
  image: `<svg viewBox="0 0 24 24" fill="none">
    <rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" stroke-width="2"/>
    <circle cx="8.5" cy="8.5" r="1.5" stroke="currentColor" stroke-width="2"/>
    <path d="m21 15-5-5L5 21" stroke="currentColor" stroke-width="2"
          stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`,
  css: `<svg viewBox="0 0 24 24" fill="none">
    <path d="M12 2L2 7l10 5 10-5-10-5z" stroke="currentColor" stroke-width="2"
          stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M2 17l10 5 10-5M2 12l10 5 10-5" stroke="currentColor" stroke-width="2"
          stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`,
  js: `<svg viewBox="0 0 24 24" fill="none">
    <polyline points="16 18 22 12 16 6" stroke="currentColor" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round"/>
    <polyline points="8 6 2 12 8 18" stroke="currentColor" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`,
  font: `<svg viewBox="0 0 24 24" fill="none">
    <polyline points="4 7 4 4 20 4 20 7" stroke="currentColor" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round"/>
    <line x1="9" y1="20" x2="15" y2="20" stroke="currentColor" stroke-width="2"
          stroke-linecap="round"/>
    <line x1="12" y1="4" x2="12" y2="20" stroke="currentColor" stroke-width="2"
          stroke-linecap="round"/>
  </svg>`,
  video: `<svg viewBox="0 0 24 24" fill="none">
    <rect x="2" y="2" width="20" height="20" rx="2" stroke="currentColor" stroke-width="2"/>
    <path d="m10 8 6 4-6 4V8z" stroke="currentColor" stroke-width="2"
          stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`,
  audio: `<svg viewBox="0 0 24 24" fill="none">
    <path d="M9 18V5l12-2v13" stroke="currentColor" stroke-width="2"
          stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="6" cy="18" r="3" stroke="currentColor" stroke-width="2"/>
    <circle cx="18" cy="16" r="3" stroke="currentColor" stroke-width="2"/>
  </svg>`,
  other: `<svg viewBox="0 0 24 24" fill="none">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"
          stroke="currentColor" stroke-width="2"
          stroke-linecap="round" stroke-linejoin="round"/>
    <polyline points="14 2 14 8 20 8" stroke="currentColor" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`,
};

/**
 * Rendert den Asset Manager mit Tabelle, Filtern und Sortierung.
 * @param {object} data - Scan-Ergebnisse (state.scanResults)
 */
function renderAssetManager(data) {
  const noProject     = document.getElementById('assets-no-project');
  const assetsContent = document.getElementById('assets-content');

  noProject.classList.add('hidden');
  assetsContent.classList.remove('hidden');

  // ── Kennzahlen befüllen ──
  const largeCount    = data.assets.filter(a => a.status === 'large' || a.status === 'critical').length;
  const criticalCount = data.assets.filter(a => a.status === 'critical').length;

  document.getElementById('assets-total').textContent    = data.assets.length;
  document.getElementById('assets-size').textContent     = formatSize(data.totalAssetsSizeKb * 1024);
  document.getElementById('assets-large').textContent    = largeCount;
  document.getElementById('assets-critical').textContent = criticalCount;

  // ── Tabelle initial rendern ──
  renderAssetTable(data.assets, 'all', 'size-desc');

  // ── Filter-Events ──
  document.querySelectorAll('#assets-filter-group .filter-btn').forEach(btn => {
    const fresh = btn.cloneNode(true);
    btn.parentNode.replaceChild(fresh, btn);
    fresh.addEventListener('click', () => {
      document.querySelectorAll('#assets-filter-group .filter-btn')
        .forEach(b => b.classList.remove('active'));
      fresh.classList.add('active');
      const sort = document.getElementById('assets-sort').value;
      renderAssetTable(data.assets, fresh.dataset.assetFilter, sort);
    });
  });

  // ── Sortier-Event ──
  const sortEl = document.getElementById('assets-sort');
  const freshSort = sortEl.cloneNode(true);
  sortEl.parentNode.replaceChild(freshSort, sortEl);
  freshSort.addEventListener('change', () => {
    const activeFilter = document.querySelector('#assets-filter-group .filter-btn.active');
    renderAssetTable(data.assets, activeFilter?.dataset.assetFilter ?? 'all', freshSort.value);
  });
}

/**
 * Filtert und sortiert die Assets und rendert die Tabellenzeilen.
 * @param {Array}  assets  - AssetInfo-Array von Rust
 * @param {string} filter  - 'all' | 'image' | 'css' | 'js' | 'font' | 'large'
 * @param {string} sort    - 'size-desc' | 'size-asc' | 'name-asc' | 'name-desc' | 'type'
 */
function renderAssetTable(assets, filter, sort) {
  // Filtern
  let filtered = assets.filter(a => {
    if (filter === 'large') return a.status === 'large' || a.status === 'critical';
    if (filter === 'all')   return true;
    return a.fileType === filter;
  });

  // Sortieren
  filtered = [...filtered].sort((a, b) => {
    switch (sort) {
      case 'size-asc':  return a.sizeBytes - b.sizeBytes;
      case 'name-asc':  return a.fileName.localeCompare(b.fileName);
      case 'name-desc': return b.fileName.localeCompare(a.fileName);
      case 'type':      return a.fileType.localeCompare(b.fileType) || b.sizeBytes - a.sizeBytes;
      default:          return b.sizeBytes - a.sizeBytes; // size-desc
    }
  });

  const tbody = document.getElementById('asset-table-body');

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="asset-empty">Keine Assets für diesen Filter gefunden.</td></tr>`;
    return;
  }

  // Daten-Attribute für Event-Delegation speichern;
  // onclick-Strings vermeiden wir bei Bildern, da der Pfad
  // Sonderzeichen enthalten kann → stattdessen data-* + addEventListener.
  tbody.innerHTML = filtered.map((asset, idx) => {
    const icon       = ASSET_ICONS[asset.fileType] ?? ASSET_ICONS.other;
    const sizeLabel  = formatSize(asset.sizeBytes);
    const sizeClass  = asset.status === 'critical' ? 'size-critical'
                     : asset.status === 'large'    ? 'size-large'
                     :                               'size-ok';
    // Verzeichnis-Teil des Pfads (ohne Dateiname)
    const dir = asset.path.includes('/')
      ? asset.path.substring(0, asset.path.lastIndexOf('/') + 1)
      : '';

    // Bild-Zeilen erhalten eine extra CSS-Klasse und data-Attribute
    const isImage    = asset.fileType === 'image';
    const rowClass   = isImage ? 'row-image' : '';
    const previewAttrs = isImage
      ? `data-preview-path="${escapeHtml(asset.absolutePath)}" data-preview-name="${escapeHtml(asset.fileName)}" data-preview-size="${escapeHtml(sizeLabel)}"`
      : '';

    // Vorschau-Hinweis im Dateinamen-Tooltip für Bilder
    const nameTip  = isImage ? ' title="Klicken für Vorschau"' : '';

    return `
      <tr class="${rowClass}" ${previewAttrs}>
        <td>
          <div class="asset-file-cell">
            <div class="asset-type-icon icon-${asset.fileType}">${icon}</div>
            <span class="asset-file-name"${nameTip}>${escapeHtml(asset.fileName)}</span>
          </div>
        </td>
        <td>
          <span class="asset-ext-badge">${escapeHtml(asset.extension.toUpperCase())}</span>
        </td>
        <td>
          <span class="asset-path" title="${escapeHtml(asset.path)}">${escapeHtml(dir) || '/'}</span>
        </td>
        <td class="asset-size">
          <span class="size-badge ${sizeClass}">${sizeLabel}</span>
        </td>
        <td style="text-align:center">
          <button class="btn-open-asset" title="In Standard-App öffnen"
                  data-open-path="${escapeHtml(asset.absolutePath)}">
            <svg viewBox="0 0 24 24" fill="none">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"
                    stroke="currentColor" stroke-width="2"
                    stroke-linecap="round" stroke-linejoin="round"/>
              <polyline points="15 3 21 3 21 9" stroke="currentColor" stroke-width="2"
                        stroke-linecap="round" stroke-linejoin="round"/>
              <line x1="10" y1="14" x2="21" y2="3" stroke="currentColor" stroke-width="2"
                    stroke-linecap="round"/>
            </svg>
          </button>
        </td>
      </tr>
    `;
  }).join('');

  // ── Event-Delegation: ein einziger Listener auf tbody ──
  // verhindert Speicherlecks durch massenhaft inline-onclick.
  tbody.addEventListener('click', (e) => {
    // "Öffnen"-Button: stoppt Bubbling damit Zeilen-Click nicht greift
    const openBtn = e.target.closest('.btn-open-asset');
    if (openBtn) {
      e.stopPropagation();
      const p = openBtn.dataset.openPath;
      if (p) openAsset(p);
      return;
    }

    // Bild-Zeile angeklickt → Lightbox öffnen
    const row = e.target.closest('tr.row-image');
    if (row) {
      openImagePreview(row.dataset.previewPath, row.dataset.previewName, row.dataset.previewSize);
    }
  });
}

/**
 * Öffnet eine Asset-Datei mit der Standard-App des Betriebssystems.
 * Wird via onclick aus der Tabelle aufgerufen.
 * @param {string} absolutePath
 */
async function openAsset(absolutePath) {
  try {
    await invoke('open_file_path', { path: absolutePath });
  } catch (err) {
    console.error('Fehler beim Öffnen:', err);
  }
}

// ─────────────────────────────────────────────────────────────
// BILD-VORSCHAU LIGHTBOX
// ─────────────────────────────────────────────────────────────

// Hält den absoluten Pfad des aktuell angezeigten Bildes
// (für den "In App öffnen"-Button im Modal).
let _lightboxCurrentPath = '';

/**
 * Öffnet die Lightbox-Vorschau für ein Bild.
 * Ruft den Rust-Befehl `get_image_preview` auf, der die Datei
 * als Base64-Data-URL zurückgibt.
 *
 * @param {string} absolutePath  - Absoluter Pfad zur Bilddatei
 * @param {string} fileName      - Dateiname für die Kopfzeile
 * @param {string} sizeLabel     - Formatierte Dateigröße (z.B. "240 KB")
 */
async function openImagePreview(absolutePath, fileName, sizeLabel) {
  _lightboxCurrentPath = absolutePath;

  const overlay   = document.getElementById('lightbox-overlay');
  const imgEl     = document.getElementById('lightbox-img');
  const spinner   = document.getElementById('lightbox-spinner');
  const errorBox  = document.getElementById('lightbox-error');
  const errorText = document.getElementById('lightbox-error-text');

  // Überschrift + Metadaten setzen
  document.getElementById('lightbox-filename').textContent = fileName;
  document.getElementById('lightbox-meta').textContent     = sizeLabel;
  document.getElementById('lightbox-path').textContent     = absolutePath;

  // Zustand zurücksetzen: Spinner zeigen, Bild + Fehler verstecken
  spinner.classList.remove('hidden');
  imgEl.classList.add('hidden');
  errorBox.classList.add('hidden');
  imgEl.src = '';

  // Overlay einblenden
  overlay.classList.remove('hidden');
  document.getElementById('lightbox-close').focus();

  try {
    // Base64-Data-URL vom Rust-Backend holen
    const dataUrl = await invoke('get_image_preview', { path: absolutePath });

    imgEl.onload = () => {
      spinner.classList.add('hidden');
      imgEl.classList.remove('hidden');
    };
    imgEl.onerror = () => {
      spinner.classList.add('hidden');
      errorText.textContent = 'Bild konnte nicht dargestellt werden.';
      errorBox.classList.remove('hidden');
    };
    imgEl.src = dataUrl;

  } catch (err) {
    spinner.classList.add('hidden');
    errorText.textContent = `Fehler: ${err}`;
    errorBox.classList.remove('hidden');
  }
}

/** Schließt die Lightbox und leert das Bild (gibt Speicher frei). */
function closeLightbox() {
  const overlay = document.getElementById('lightbox-overlay');
  overlay.classList.add('hidden');
  // src leeren damit der Browser den Blob-Speicher freigibt
  document.getElementById('lightbox-img').src = '';
  _lightboxCurrentPath = '';
}

// ── Lightbox-Events ──────────────────────────────────────────

// Schließen-Button
document.getElementById('lightbox-close')
  .addEventListener('click', closeLightbox);

// Klick auf das Overlay selbst (außerhalb der Box)
document.getElementById('lightbox-overlay')
  .addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeLightbox();
  });

// Escape-Taste schließt die Lightbox
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const overlay = document.getElementById('lightbox-overlay');
    if (!overlay.classList.contains('hidden')) closeLightbox();
  }
});

// "In App öffnen"-Button im Modal
document.getElementById('lightbox-open-btn')
  .addEventListener('click', () => {
    if (_lightboxCurrentPath) openAsset(_lightboxCurrentPath);
  });

/**
 * Formatiert Bytes in eine lesbare Größenangabe.
 * @param {number} bytes
 * @returns {string}
 */
function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  if (bytes >= 1024)        return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

// "Zum Dashboard"-Button im Audit-Leer-Zustand
document.getElementById('btn-audit-open-project')
  .addEventListener('click', () => switchView('dashboard'));

// "Zum Dashboard"-Button im Asset-Leer-Zustand
document.getElementById('btn-assets-open-project')
  .addEventListener('click', () => switchView('dashboard'));

// ─────────────────────────────────────────────────────────────
// HILFSFUNKTIONEN
// ─────────────────────────────────────────────────────────────

/**
 * Schützt vor XSS beim Einfügen von Benutzer-/Datei-Inhalten ins DOM.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─────────────────────────────────────────────────────────────
// Live Webpreview
// ─────────────────────────────────────────────────────────────

let currentPreviewPort = null;

async function startLivePreview(path) {
  const badge = document.getElementById('preview-badge');
  if (badge) { badge.textContent = 'Lädt…'; badge.style.color = 'var(--warning)'; }

  currentPreviewPort = await invoke('start_preview_server', { path });

  const iframe = document.getElementById('preview-frame');
  iframe.src = `http://127.0.0.1:${currentPreviewPort}/index.html`;

  if (badge) { badge.textContent = 'Live'; badge.style.color = 'var(--success)'; }
}

// Toggle-Button für den Preview-Bereich
document.getElementById('preview-toggle')?.addEventListener('click', () => {
  const toggle = document.getElementById('preview-toggle');
  const body   = document.getElementById('preview-body');
  const open   = toggle.getAttribute('aria-expanded') === 'true';

  toggle.setAttribute('aria-expanded', String(!open));
  body.classList.toggle('open', !open);
});

// ─────────────────────────────────────────────────────────────
// DEMO-DATEN
// Werden verwendet bis der Rust-Scan-Befehl implementiert ist.
// ─────────────────────────────────────────────────────────────

/**
 * Liefert realistische Beispiel-Daten für die UI-Vorschau.
 * @param {string} path
 * @returns {object}
 */
function getDemoData(path) {
  return {
    healthScore: 72,
    totalPages:  8,
    cleanPages:  5,
    seoErrors:   4,
    seoWarnings: 7,
    largeImages: 3,
    missingAlt:  5,
    issues: [
      { severity: 'error',   title: 'Fehlende <title>-Tag',         file: 'kontakt.html',    category: 'SEO' },
      { severity: 'error',   title: 'Fehlende Meta-Description',     file: 'ueber-uns.html',  category: 'SEO' },
      { severity: 'error',   title: 'Mehrere <h1>-Tags auf Seite',   file: 'index.html',      category: 'Struktur' },
      { severity: 'error',   title: 'Interner Link 404',             file: 'index.html',      category: 'Links' },
      { severity: 'warning', title: 'Bild ohne Alt-Attribut',        file: 'galerie.html',    category: 'SEO' },
      { severity: 'warning', title: 'Bild ohne Alt-Attribut',        file: 'index.html',      category: 'SEO' },
      { severity: 'warning', title: 'Bild zu groß (1.2 MB)',         file: 'assets/hero.jpg', category: 'Performance' },
      { severity: 'warning', title: 'Bild zu groß (820 KB)',         file: 'assets/team.jpg', category: 'Performance' },
      { severity: 'warning', title: '<h2> vor <h1> verwendet',       file: 'blog.html',       category: 'Struktur' },
      { severity: 'info',    title: 'Open-Graph-Tags fehlen',        file: 'index.html',      category: 'Social' },
      { severity: 'info',    title: 'Kein canonical-Link gesetzt',   file: 'kontakt.html',    category: 'SEO' },
    ],
  };
}
