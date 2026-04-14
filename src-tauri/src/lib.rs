/// FerroWeb – Rust-Backend
///
/// Tauri-Befehl `scan_project`:
///   Analysiert einen lokalen Ordner auf SEO- und Performance-Probleme.
///   Gibt strukturierte Ergebnisse inkl. Per-Page-Zusammenfassung zurück.

use base64::{engine::general_purpose, Engine as _};
use scraper::{Html, Selector};
use serde::Serialize;
use std::{
    collections::HashSet,
    path::{Path, PathBuf}, // Hier ist Path & PathBuf jetzt zentral
    fs::File,              // Neu für den Server
    thread,                // Neu für den Server
};
use walkdir::WalkDir;
use tiny_http::{Server, Response}; // Neu für den Server

// ─────────────────────────────────────────────────────────────────────────────
// Datenstrukturen
// ─────────────────────────────────────────────────────────────────────────────

/// Einzelnes gefundenes Problem mit konkreter Verbesserungsempfehlung.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Issue {
    severity:   String,  // "error" | "warning" | "info"
    title:      String,
    file:       String,
    category:   String,
    suggestion: String,  // Konkrete Handlungsempfehlung für den Entwickler
}

/// Zusammenfassung einer einzelnen HTML-Seite für den SEO-Audit.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PageSummary {
    path:          String,
    error_count:   usize,
    warning_count: usize,
    info_count:    usize,
    title:         String,  // Gefundener Titel-Text (leer = nicht vorhanden)
    description:   String,  // Gefundene Meta-Description (leer = nicht vorhanden)
}

/// Informationen zu einer einzelnen Asset-Datei.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AssetInfo {
    path:          String,  // Relativer Pfad (zur Anzeige)
    absolute_path: String,  // Absoluter Pfad (zum Öffnen)
    file_name:     String,  // Nur Dateiname
    file_type:     String,  // "image" | "css" | "js" | "font" | "video" | "audio" | "other"
    extension:     String,  // Dateierweiterung in Kleinbuchstaben
    size_bytes:    u64,
    size_kb:       f64,     // Auf 1 Dezimalstelle gerundet
    status:        String,  // "ok" | "large" (>500KB) | "critical" (>1MB)
}

/// Vollständiges Scan-Ergebnis.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanResults {
    health_score:         u32,
    total_pages:          usize,
    clean_pages:          usize,
    seo_errors:           usize,
    seo_warnings:         usize,
    large_images:         usize,
    missing_alt:          usize,
    issues:               Vec<Issue>,
    pages:                Vec<PageSummary>,
    assets:               Vec<AssetInfo>,  // Alle gefundenen Assets
    total_assets_size_kb: f64,             // Gesamtgröße aller Assets
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri-Befehl
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
fn scan_project(path: String) -> Result<ScanResults, String> {
    let root = PathBuf::from(&path);

    if !root.exists()  { return Err(format!("Pfad existiert nicht: {}", path)); }
    if !root.is_dir()  { return Err(format!("Kein Verzeichnis: {}", path)); }

    let mut issues:             Vec<Issue>       = Vec::new();
    let mut pages:              Vec<PageSummary> = Vec::new();
    let mut assets:             Vec<AssetInfo>   = Vec::new();
    let mut total_pages         = 0usize;
    let mut missing_alt_total   = 0usize;
    let mut large_images_total  = 0usize;
    let mut total_assets_size: u64 = 0;

    // ── Alle Dateien rekursiv durchlaufen ─────────────────────────────────────
    for entry in WalkDir::new(&root)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
    {
        let file_path = entry.path();
        let ext = file_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();

        match ext.as_str() {
            // ── HTML: SEO-Analyse ─────────────────────────────────────────────
            "html" | "htm" => {
                total_pages += 1;
                let rel = relative_path(&root, file_path);
                match std::fs::read_to_string(file_path) {
                    Ok(content) => {
                        let summary = scan_html(
                            &content, &rel, &root, file_path,
                            &mut issues, &mut missing_alt_total,
                        );
                        pages.push(summary);
                    }
                    Err(e) => issues.push(Issue {
                        severity:   "error".into(),
                        title:      format!("Datei nicht lesbar: {}", e),
                        file:       rel,
                        category:   "System".into(),
                        suggestion: "Prüfe die Dateirechte und stelle sicher, dass die Datei nicht gesperrt ist.".into(),
                    }),
                }
            }

            // ── Assets: alle nicht-HTML-Dateien erfassen ──────────────────────
            _ => {
                if let Ok(meta) = std::fs::metadata(file_path) {
                    let size_bytes = meta.len();
                    let size_kb    = size_bytes as f64 / 1024.0;
                    let file_type  = asset_type(&ext);
                    let rel        = relative_path(&root, file_path);
                    let abs        = file_path.to_string_lossy().to_string();
                    let name       = file_path.file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();

                    // Bilder > 500 KB: SEO-Issue erzeugen
                    if file_type == "image" && size_kb > 500.0 {
                        large_images_total += 1;
                        let size_display = if size_kb >= 1024.0 {
                            format!("{:.1} MB", size_kb / 1024.0)
                        } else {
                            format!("{:.0} KB", size_kb)
                        };
                        issues.push(Issue {
                            severity:   "warning".into(),
                            title:      format!("Bild zu groß ({} – empfohlen <500 KB)", size_display),
                            file:       rel.clone(),
                            category:   "Performance".into(),
                            suggestion: "Komprimiere das Bild mit Squoosh (squoosh.app) oder TinyPNG. \
                                         Große Bilder verlangsamen die Ladezeit – Google bewertet \
                                         PageSpeed als Ranking-Faktor. Empfohlenes Format: WebP.".into(),
                        });
                    }

                    let status = if size_kb > 1024.0      { "critical".to_string() }
                                 else if size_kb > 500.0  { "large".to_string() }
                                 else                     { "ok".to_string() };

                    total_assets_size += size_bytes;
                    assets.push(AssetInfo {
                        path: rel,
                        absolute_path: abs,
                        file_name: name,
                        file_type,
                        extension: ext.clone(),
                        size_bytes,
                        size_kb: (size_kb * 10.0).round() / 10.0,
                        status,
                    });
                }
            }
        }
    }

    // Assets nach Größe absteigend sortieren (größte zuerst)
    assets.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));

    // ── Gesamtstatistiken berechnen ───────────────────────────────────────────

    let seo_errors = issues.iter()
        .filter(|i| i.severity == "error").count();

    let seo_warnings = issues.iter()
        .filter(|i| i.severity == "warning" && i.category != "Performance").count();

    // Seiten ohne eigene Issues
    let pages_with_issues: HashSet<&str> = issues.iter()
        .filter(|i| i.file.ends_with(".html") || i.file.ends_with(".htm"))
        .map(|i| i.file.as_str())
        .collect();
    let clean_pages = total_pages.saturating_sub(pages_with_issues.len());

    // Health Score: Abzug je Problem-Schwere, mindestens 0
    let penalty = (seo_errors * 8)
        .saturating_add(seo_warnings * 3)
        .saturating_add(large_images_total * 2)
        .min(100);
    let health_score = (100 - penalty) as u32;

    Ok(ScanResults {
        health_score,
        total_pages,
        clean_pages,
        seo_errors,
        seo_warnings,
        large_images: large_images_total,
        missing_alt:  missing_alt_total,
        issues,
        pages,
        assets,
        total_assets_size_kb: (total_assets_size as f64 / 1024.0 * 10.0).round() / 10.0,
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML-Analyse pro Seite
// ─────────────────────────────────────────────────────────────────────────────

/// Analysiert eine HTML-Datei vollständig und gibt eine PageSummary zurück.
/// Alle gefundenen Issues werden in `issues` eingefügt.
fn scan_html(
    content:          &str,
    rel_path:         &str,
    root:             &Path,
    file_path:        &Path,
    issues:           &mut Vec<Issue>,
    missing_alt_count: &mut usize,
) -> PageSummary {
    let doc = Html::parse_document(content);

    // Vor dem Prüfen: aktuelle Issue-Anzahl merken, um Deltas zu berechnen
    let issues_before = issues.len();

    // ── SEO-Pflicht-Checks ────────────────────────────────────────────────────

    let title_text       = check_title(&doc, rel_path, issues);
    let description_text = check_meta_description(&doc, rel_path, issues);

    // ── Struktur-Checks ───────────────────────────────────────────────────────

    check_headings(&doc, rel_path, issues);
    check_images(&doc, rel_path, issues, missing_alt_count);
    check_links(&doc, rel_path, root, file_path, issues);

    // ── Erweiterte SEO-Checks (Info-Level) ────────────────────────────────────

    check_lang_attr(&doc, rel_path, issues);
    check_viewport(&doc, rel_path, issues);
    check_canonical(&doc, rel_path, issues);
    check_og_tags(&doc, rel_path, issues);

    // ── Per-Page-Statistiken aus den neuen Issues berechnen ───────────────────

    let new_issues = &issues[issues_before..];
    let error_count   = new_issues.iter().filter(|i| i.severity == "error").count();
    let warning_count = new_issues.iter().filter(|i| i.severity == "warning").count();
    let info_count    = new_issues.iter().filter(|i| i.severity == "info").count();

    PageSummary {
        path:          rel_path.to_string(),
        error_count,
        warning_count,
        info_count,
        title:         title_text,
        description:   description_text,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Einzel-Checks (je eine Funktion pro Prüfung)
// ─────────────────────────────────────────────────────────────────────────────

/// Prüft <title>. Gibt den gefundenen Titeltext zurück (leer = fehlend).
fn check_title(doc: &Html, rel: &str, issues: &mut Vec<Issue>) -> String {
    let sel   = Selector::parse("title").unwrap();
    let text  = doc.select(&sel)
        .next()
        .map(|el| el.text().collect::<String>())
        .unwrap_or_default();
    let trimmed = text.trim().to_string();

    if trimmed.is_empty() {
        issues.push(Issue {
            severity:   "error".into(),
            title:      "Fehlender oder leerer <title>-Tag".into(),
            file:       rel.into(),
            category:   "SEO".into(),
            suggestion: "Füge einen einzigartigen Titel im <head> ein: <title>Seitenname – Kurzbeschreibung</title>. \
                         Ideale Länge: 50–60 Zeichen. Der Titel erscheint in Google-Suchergebnissen als blauer Link \
                         und ist der wichtigste On-Page-SEO-Faktor.".into(),
        });
    }

    trimmed
}

/// Prüft <meta name="description">. Gibt den Content zurück (leer = fehlend).
fn check_meta_description(doc: &Html, rel: &str, issues: &mut Vec<Issue>) -> String {
    let sel  = Selector::parse("meta[name='description']").unwrap();
    let text = doc.select(&sel)
        .next()
        .and_then(|el| el.value().attr("content"))
        .unwrap_or("")
        .trim()
        .to_string();

    if text.is_empty() {
        issues.push(Issue {
            severity:   "error".into(),
            title:      "Fehlende oder leere Meta-Description".into(),
            file:       rel.into(),
            category:   "SEO".into(),
            suggestion: "Füge im <head> ein: <meta name=\"description\" content=\"Deine Beschreibung hier\">. \
                         Ideale Länge: 150–160 Zeichen. Google zeigt diese Beschreibung unter dem Seitentitel \
                         in den Suchergebnissen an – ein guter Text erhöht die Klickrate (CTR) erheblich.".into(),
        });
    }

    text
}

/// Prüft H1–H2-Hierarchie: Kein H1, mehrere H1s, H2 vor H1.
fn check_headings(doc: &Html, rel: &str, issues: &mut Vec<Issue>) {
    let sel_h1 = Selector::parse("h1").unwrap();
    let h1_count = doc.select(&sel_h1).count();

    if h1_count == 0 {
        issues.push(Issue {
            severity:   "warning".into(),
            title:      "Kein <h1>-Tag gefunden".into(),
            file:       rel.into(),
            category:   "Struktur".into(),
            suggestion: "Füge genau einen <h1> mit dem Hauptkeyword der Seite hinzu – er signalisiert Google \
                         das zentrale Thema. Beispiel: <h1>Webdesign Agentur Berlin</h1>. \
                         Jede Seite sollte exakt einen <h1> haben.".into(),
        });
    } else if h1_count > 1 {
        issues.push(Issue {
            severity:   "error".into(),
            title:      format!("{} <h1>-Tags gefunden – nur einer erlaubt", h1_count),
            file:       rel.into(),
            category:   "Struktur".into(),
            suggestion: "Behalte nur einen <h1> – den wichtigsten Seitentitel. Alle weiteren Überschriften \
                         sollten <h2>, <h3> usw. sein. Mehrere <h1>-Tags verwirren Suchmaschinen und \
                         schwächen die Relevanz des Hauptkeywords.".into(),
        });
    }

    // <h2> vor dem ersten <h1> im DOM?
    let sel_h1h2 = Selector::parse("h1, h2").unwrap();
    if doc.select(&sel_h1h2).next().map(|el| el.value().name()) == Some("h2") {
        issues.push(Issue {
            severity:   "warning".into(),
            title:      "<h2> erscheint vor dem ersten <h1>".into(),
            file:       rel.into(),
            category:   "Struktur".into(),
            suggestion: "Halte die Überschriften-Hierarchie ein: <h1> kommt zuerst, danach <h2>, <h3> usw. \
                         Eine korrekte Hierarchie hilft Google, die Seitenstruktur zu verstehen, \
                         und verbessert die Barrierefreiheit.".into(),
        });
    }
}

/// Prüft alle <img>-Tags auf fehlendes oder leeres alt-Attribut.
fn check_images(
    doc:              &Html,
    rel:              &str,
    issues:           &mut Vec<Issue>,
    missing_alt_count: &mut usize,
) {
    let sel = Selector::parse("img").unwrap();
    for img in doc.select(&sel) {
        let alt_ok = img.value().attr("alt")
            .map(|a| !a.trim().is_empty())
            .unwrap_or(false);

        if !alt_ok {
            *missing_alt_count += 1;
            let src = img.value().attr("src").unwrap_or("(kein src)");
            issues.push(Issue {
                severity:   "warning".into(),
                title:      format!("Bild ohne alt-Attribut: {}", truncate(src, 55)),
                file:       rel.into(),
                category:   "SEO".into(),
                suggestion: "Füge ein aussagekräftiges alt-Attribut hinzu: <img src=\"...\" alt=\"Beschreibung des Bildes\">. \
                             Google kann Bilder nicht sehen – der Alt-Text ist der einzige Weg, \
                             Bilder in der Google-Bildersuche zu ranken. Beschreibe, was auf dem Bild zu sehen ist.".into(),
            });
        }
    }
}

/// Prüft interne Links auf Existenz der Zieldatei.
fn check_links(
    doc:       &Html,
    rel:       &str,
    root:      &Path,
    file_path: &Path,
    issues:    &mut Vec<Issue>,
) {
    let sel = Selector::parse("a[href]").unwrap();
    for a in doc.select(&sel) {
        let href = match a.value().attr("href") { Some(h) => h, None => continue };

        if !is_internal_link(href) { continue; }

        // Anker entfernen, leere hrefs überspringen
        let href_path = href.split('#').next().unwrap_or("").trim();
        if href_path.is_empty() { continue; }

        let target = if href_path.starts_with('/') {
            root.join(&href_path[1..])
        } else {
            match file_path.parent() {
                Some(dir) => dir.join(href_path),
                None => continue,
            }
        };

        if !target.exists() {
            issues.push(Issue {
                severity:   "error".into(),
                title:      format!("Kaputtes Link-Ziel: {}", truncate(href, 65)),
                file:       rel.into(),
                category:   "Links".into(),
                suggestion: "Prüfe ob die verlinkte Datei existiert und der Pfad korrekt geschrieben ist. \
                             Kaputte Links verschlechtern die Nutzererfahrung und können das Google-Ranking senken, \
                             da Crawler die Seite als unvollständig bewerten.".into(),
            });
        }
    }
}

/// Prüft ob das <html>-Tag ein lang-Attribut hat.
fn check_lang_attr(doc: &Html, rel: &str, issues: &mut Vec<Issue>) {
    let sel      = Selector::parse("html").unwrap();
    let has_lang = doc.select(&sel)
        .next()
        .and_then(|el| el.value().attr("lang"))
        .map(|l| !l.trim().is_empty())
        .unwrap_or(false);

    if !has_lang {
        issues.push(Issue {
            severity:   "info".into(),
            title:      "Kein lang-Attribut am <html>-Tag".into(),
            file:       rel.into(),
            category:   "Barrierefreiheit".into(),
            suggestion: "Füge die Sprache zum <html>-Tag hinzu: <html lang=\"de\">. \
                         Google nutzt dieses Attribut, um die Sprache der Seite zu erkennen \
                         und die Seite in der richtigen Region anzuzeigen. \
                         Screenreader für sehbehinderte Nutzer benötigen es ebenfalls.".into(),
        });
    }
}

/// Prüft ob <meta name="viewport"> vorhanden ist (wichtig für Mobile).
fn check_viewport(doc: &Html, rel: &str, issues: &mut Vec<Issue>) {
    let sel      = Selector::parse("meta[name='viewport']").unwrap();
    let has_vp   = doc.select(&sel).next().is_some();

    if !has_vp {
        issues.push(Issue {
            severity:   "warning".into(),
            title:      "Kein Viewport-Meta-Tag – Seite nicht mobiloptimiert".into(),
            file:       rel.into(),
            category:   "Mobile".into(),
            suggestion: "Füge im <head> ein: <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">. \
                         Google bewertet Mobile-Friendliness als wichtigen Ranking-Faktor (Mobile-First-Index). \
                         Ohne diesen Tag wird die Seite auf Smartphones nicht korrekt skaliert.".into(),
        });
    }
}

/// Prüft ob <link rel="canonical"> vorhanden ist.
fn check_canonical(doc: &Html, rel: &str, issues: &mut Vec<Issue>) {
    let sel    = Selector::parse("link[rel='canonical']").unwrap();
    let has_cn = doc.select(&sel).next().is_some();

    if !has_cn {
        issues.push(Issue {
            severity:   "info".into(),
            title:      "Kein <link rel=\"canonical\"> gesetzt".into(),
            file:       rel.into(),
            category:   "SEO".into(),
            suggestion: "Füge im <head> ein: <link rel=\"canonical\" href=\"https://deine-domain.de/seite\">. \
                         Der Canonical-Tag verhindert Duplicate-Content-Probleme, wenn dieselbe Seite \
                         unter mehreren URLs erreichbar ist. Google bevorzugt die angegebene URL \
                         als \"offizielle\" Version.".into(),
        });
    }
}

/// Prüft ob Open-Graph-Tags (og:title, og:description) vorhanden sind.
fn check_og_tags(doc: &Html, rel: &str, issues: &mut Vec<Issue>) {
    // Statische Strings vermeiden Lifetime-Probleme mit dem Selector-Borrow
    let checks: &[(&str, &str)] = &[
        ("meta[property='og:title']",       "og:title"),
        ("meta[property='og:description']", "og:description"),
    ];

    for (selector_str, prop) in checks {
        let sel = Selector::parse(selector_str).unwrap();
        if doc.select(&sel).next().is_none() {
            let suggestion = if *prop == "og:title" {
                "Füge hinzu: <meta property=\"og:title\" content=\"Dein Seitentitel\">. \
                 Dieser Titel erscheint, wenn die Seite in Facebook, LinkedIn oder WhatsApp geteilt wird. \
                 Ohne ihn wird ein automatisch generierter oder gar kein Titel angezeigt."
            } else {
                "Füge hinzu: <meta property=\"og:description\" content=\"Kurze Beschreibung\">. \
                 Diese Beschreibung erscheint beim Teilen in sozialen Netzwerken und erhöht \
                 die Klickrate erheblich. Ideal: 2 Sätze, ca. 100–150 Zeichen."
            };
            issues.push(Issue {
                severity:   "info".into(),
                title:      format!("Fehlender Open-Graph-Tag: <meta property=\"{}\">", prop),
                file:       rel.into(),
                category:   "Social".into(),
                suggestion: suggestion.into(),
            });
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Hilfsfunktionen
// ─────────────────────────────────────────────────────────────────────────────

/// Ordnet einer Dateierweiterung einen Asset-Typ zu.
fn asset_type(ext: &str) -> String {
    match ext {
        "jpg"|"jpeg"|"png"|"gif"|"webp"|"bmp"|"svg"|"ico"|"avif" => "image",
        "css"|"scss"|"sass"|"less"                                => "css",
        "js"|"mjs"|"ts"|"jsx"|"tsx"                              => "js",
        "woff"|"woff2"|"ttf"|"otf"|"eot"                         => "font",
        "mp4"|"webm"|"ogv"|"mov"|"avi"                           => "video",
        "mp3"|"wav"|"ogg"|"flac"|"aac"                           => "audio",
        _                                                         => "other",
    }.to_string()
}

fn is_internal_link(href: &str) -> bool {
    !href.starts_with("http://")
        && !href.starts_with("https://")
        && !href.starts_with("mailto:")
        && !href.starts_with("tel:")
        && !href.starts_with("javascript:")
        && !href.starts_with('#')
        && !href.is_empty()
}

fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.to_string_lossy().to_string())
}

fn truncate(s: &str, max_len: usize) -> String {
    if s.len() <= max_len { s.to_string() }
    else { format!("{}…", &s[..max_len]) }
}

// ─────────────────────────────────────────────────────────────────────────────
// App-Entry
// ─────────────────────────────────────────────────────────────────────────────

/// Liest eine Bilddatei und gibt sie als Data-URL zurück (data:image/...;base64,...).
/// Das Frontend kann diese direkt als <img src="..."> verwenden.
#[tauri::command]
fn get_image_preview(path: String) -> Result<String, String> {
    let p = Path::new(&path);

    // Sicherheit: nur echte Bilddateien erlauben
    let ext = p.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let mime = match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png"          => "image/png",
        "gif"          => "image/gif",
        "webp"         => "image/webp",
        "svg"          => "image/svg+xml",
        "ico"          => "image/x-icon",
        "bmp"          => "image/bmp",
        "avif"         => "image/avif",
        _ => return Err(format!("Nicht unterstütztes Bildformat: {}", ext)),
    };

    let bytes = std::fs::read(p).map_err(|e| format!("Datei konnte nicht gelesen werden: {}", e))?;
    let b64   = general_purpose::STANDARD.encode(&bytes);

    Ok(format!("data:{};base64,{}", mime, b64))
}

/// Öffnet eine Datei mit der Standard-Anwendung des Betriebssystems
/// (z.B. Bild in der Foto-App, CSS in VS Code).
#[tauri::command]
fn open_file_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(&path, None::<&str>)
        .map_err(|e| e.to_string())
}

fn mime_type(path: &PathBuf) -> String {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase().as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css"          => "text/css; charset=utf-8",
        "js" | "mjs"   => "application/javascript; charset=utf-8",
        "json"         => "application/json",
        "svg"          => "image/svg+xml",
        "png"          => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif"          => "image/gif",
        "webp"         => "image/webp",
        "ico"          => "image/x-icon",
        "woff"         => "font/woff",
        "woff2"        => "font/woff2",
        _              => "application/octet-stream",
    }.to_string()
}

#[tauri::command]
fn start_preview_server(path: String) -> Result<u16, String> {
    // Port 0 bedeutet: Das OS sucht uns einen freien Port aus
    let server = Server::http("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = server.server_addr().to_string()
    .split(':')
    .last()
    .and_then(|p| p.parse::<u16>().ok())
    .unwrap_or(0);
    let root = PathBuf::from(path);

    thread::spawn(move || {
        for request in server.incoming_requests() {
            // URL säubern und Pfad bauen
            let url = request.url().trim_start_matches('/');
            let mut file_path = root.join(url);

            
            if file_path.is_dir() {
                file_path = file_path.join("index.html");
            }

            if file_path.exists() && file_path.is_file() {
                if let Ok(file) = File::open(&file_path) {
                    let mime = mime_type(&file_path);
                    let response = Response::from_file(file)
                        .with_header(
                            tiny_http::Header::from_bytes(
                                &b"Content-Type"[..],
                                mime.as_bytes(),
                            ).unwrap()
                        );
                    let _ = request.respond(response);
                }
            } else {
                let response = Response::from_string("Datei nicht gefunden")
                    .with_status_code(404);
                let _ = request.respond(response);
            }
        }
    });

    Ok(port)
}




#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![scan_project, open_file_path, get_image_preview, start_preview_server])
        .run(tauri::generate_context!())
        .expect("Fehler beim Starten der Anwendung");
}
