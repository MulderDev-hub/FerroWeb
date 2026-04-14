# FerroWeb 0.1.2

**Lokale Desktop-App für Webentwickler und SEO-Spezialisten.**  
FerroWeb analysiert HTML/CSS/JS-Dateien direkt vom Dateisystem — ohne Cloud, ohne Uploads, ohne Tracking.

---

## Was ist FerroWeb?

FerroWeb ist eine On-Premise-Desktop-Anwendung, die Webprojekte lokal auf SEO-Probleme, fehlende Meta-Tags, kaputte Links und Asset-Performance untersucht. Alle Analysen laufen vollständig auf dem eigenen Rechner — kein Byte verlässt das Gerät.

Gebaut mit **Tauri v2** (Rust-Backend + Vanilla-JS-Frontend), läuft auf Windows, macOS und Linux.

---

## Features (MVP)

### Dashboard
- **Health Score** — gewichteter Gesamtscore (0–100) auf Basis gefundener Fehler, Warnungen und Performance-Probleme
- Übersicht: SEO-Fehler, Asset-Probleme, gescannte Seiten
- Gefilterte Problemliste mit konkreten Verbesserungsempfehlungen
- **Live-Vorschau** — aufklappbarer Bereich mit eingebettetem Webview des Projekts (lokaler HTTP-Server in Rust, dynamischer Port, korrekte MIME-Types für HTML/CSS/JS/Fonts/Bilder)

### SEO Audit
- Per-Seite-Analyse aller HTML-Dateien im Projektordner (rekursiv)
- Prüft auf:
  - Fehlenden oder leeren `<title>`
  - Fehlende `<meta name="description">`
  - Falsche Überschriften-Hierarchie (`<h1>`–`<h6>`)
  - Bilder ohne `alt`-Attribut
  - Kaputte interne Links (404-Check auf dem Dateisystem)
  - Fehlendes `lang`-Attribut am `<html>`-Tag
  - Fehlender Viewport-Meta-Tag (Mobile-Optimierung)
  - Fehlender `<link rel="canonical">`
  - Fehlende Open-Graph-Tags (`og:title`, `og:description`)
- Accordion-Ansicht pro Seite mit Titel, Description-Vorschau und allen Issues
- Zu jedem Problem: konkreter Erklärungstext mit Google-Rankingbezug

### Asset Manager
- Auflistung aller Projektdateien: Bilder, CSS, JS, Fonts, Video, Audio
- Größen-Badges: OK / Zu groß (>500 KB) / Kritisch (>1 MB)
- Filter nach Dateityp und Sortierung nach Größe oder Name
- **Bild-Vorschau** direkt in der App (Lightbox mit Base64-Encoding — keine Netzwerkanfragen)
- Dateien mit einem Klick in der Standard-App des Betriebssystems öffnen

---

## Tech-Stack

| Bereich       | Technologie                        |
|---------------|------------------------------------|
| Desktop-Shell | Tauri v2                           |
| Backend       | Rust (HTML-Parser, Datei-I/O)      |
| HTML-Parsing  | `scraper` 0.21 (basiert auf html5ever) |
| Verzeichnisse | `walkdir` 2                        |
| Bild-Encoding | `base64` 0.22                      |
| HTTP-Server   | `tiny_http` (Live-Vorschau)        |
| Dialoge       | `tauri-plugin-dialog` 2            |
| Frontend      | Vanilla HTML / CSS / JavaScript    |
| Styling       | Custom CSS Properties (Dark Mode)  |

---

## Voraussetzungen

- [Rust](https://www.rust-lang.org/tools/install) (stable, ≥ 1.77)
- [Tauri CLI](https://tauri.app/start/):
  ```bash
  cargo install tauri-cli --version "^2"
  ```
- **Windows:** Microsoft C++ Build Tools oder Visual Studio mit "Desktop development with C++"
- **Linux:** `libwebkit2gtk-4.1`, `libgtk-3` und weitere — siehe [Tauri Linux Prerequisites](https://tauri.app/start/prerequisites/#linux)
- **macOS:** Xcode Command Line Tools

---

## Installation & Start

```bash
# Repository klonen
git clone https://github.com/dein-name/ferroweb.git
cd ferroweb

# Entwicklungsmodus starten (hot-reload für Frontend, Rust-Rebuild bei Änderungen)
cargo tauri dev

# Produktions-Bundle erstellen (.exe / .dmg / .AppImage)
cargo tauri build
```

> **Windows-Hinweis:** Falls `cargo tauri dev` mit "Zugriff verweigert" abbricht,
> ist noch eine alte Instanz aktiv. Prozess beenden mit:
> ```bash
> taskkill //F //IM ferroweb.exe
> ```

---

## Projektstruktur

```
ferroweb/
├── src/                        # Frontend (Vanilla HTML/CSS/JS)
│   ├── index.html              # App-Shell: Sidebar + alle Views
│   ├── styles.css              # Design-System (CSS Custom Properties)
│   └── main.js                 # Gesamte UI-Logik, Tauri-Invoke-Aufrufe
│
├── src-tauri/                  # Rust-Backend (Tauri)
│   ├── src/
│   │   ├── lib.rs              # Alle Tauri-Commands, SEO-Analyse, Asset-Scan
│   │   └── main.rs             # Entry-Point (ruft nur lib::run())
│   ├── capabilities/
│   │   └── default.json        # Tauri-Berechtigungen (Fenster, Dialog, Opener)
│   ├── Cargo.toml              # Rust-Abhängigkeiten
│   └── tauri.conf.json         # App-Konfiguration (Fenstergröße, Bundle-Icons)
│
└── CLAUDE.md                   # Hinweise für KI-Assistenten (Claude Code)
```

---

## Tauri-Commands (Rust → JS)

| Command             | Parameter       | Rückgabe         | Beschreibung                                  |
|---------------------|-----------------|------------------|-----------------------------------------------|
| `scan_project`        | `path: String`  | `ScanResults`       | Vollständiger SEO- und Asset-Scan eines Ordners |
| `get_image_preview`   | `path: String`  | `String` (Data-URL) | Bild als `data:image/...;base64,...` zurückgeben |
| `open_file_path`      | `path: String`  | —                   | Datei in Standard-App des OS öffnen           |
| `start_preview_server`| `path: String`  | `u16` (Port)        | Startet lokalen HTTP-Server für das Projektverzeichnis, gibt den dynamisch vergebenen Port zurück |

Aufgerufen im Frontend via:
```js
const result = await window.__TAURI__.core.invoke('scan_project', { path: '/pfad/zum/projekt' });
```

---

## SEO-Scoring

Der Health Score wird nach folgendem Schema berechnet:

```
score = 100 − (Fehler × 8) + (Warnungen × 3) + (große Bilder × 2)
```

Minimum: 0 — Maximum: 100.

| Bereich   | Severität | Abzug |
|-----------|-----------|-------|
| Fehlender `<title>` | error | −8 |
| Kaputte interne Links | error | −8 |
| Fehlende Meta-Description | error | −8 |
| Bild ohne `alt` | warning | −3 |
| Bild > 500 KB | warning | −2 |
| Fehlender Viewport-Tag | warning | −3 |
| Fehlendes `lang`-Attribut | info | −3 |
| Fehlende OG-Tags | info | −3 |

---

## Sicherheit & Datenschutz

- **Keine Netzwerkanfragen** — alle Analysen laufen vollständig lokal
- **Keine Telemetrie** — es werden keinerlei Nutzungsdaten erhoben
- Tauri-Capabilities begrenzen den Dateizugriff auf den vom Nutzer gewählten Ordner
- Bild-Vorschauen werden als Base64 im Arbeitsspeicher gehalten und nie auf Disk geschrieben

---

## Geplante Features (Post-MVP)

- [x] Eingebetteter lokaler HTTP-Server für Live-Vorschau im Webview
- [ ] PDF-Export der Audit-Ergebnisse
- [ ] Automatische Bildkompression
- [ ] Multi-Projekt-Dashboard
- [ ] Persistente Projektliste (zuletzt geöffnete Ordner)
- [ ] Lighthouse-ähnlicher Performance-Score

---

## Mitwirken

Pull Requests sind willkommen. Für größere Änderungen bitte zuerst ein Issue öffnen.

1. Fork erstellen
2. Feature-Branch anlegen: `git checkout -b feature/mein-feature`
3. Rust-Code prüfen: `cd src-tauri && cargo check`
4. Tests ausführen: `cd src-tauri && cargo test`
5. Pull Request öffnen

---

## Lizenz

MIT — siehe [LICENSE](LICENSE).
