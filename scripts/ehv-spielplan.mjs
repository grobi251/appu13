// Holt den aktuellen Spielplan von ehv-nrw.de und schreibt ihn nach data/spielplan.json.
// Läuft automatisch über .github/workflows/spielplan.yml (oder lokal: node scripts/ehv-spielplan.mjs).
// Die EHV-Seite lädt die Spiele per JavaScript nach – deshalb wird sie in einem echten Browser (Playwright) geöffnet.
import { chromium } from "playwright";
import fs from "node:fs";

const URL = process.env.EHV_URL || "https://ehv-nrw.de/leagues/league/u13/lln/70/";
const OUT = process.env.OUT_FILE || "data/spielplan.json";
const SEASON_START_YEAR = +(process.env.SEASON_START_YEAR || 2026); // Saison 2026/27

const browser = await chromium.launch();
const page = await browser.newPage({ locale: "de-DE", timezoneId: "Europe/Berlin" });

// Falls die Seite die Daten als JSON nachlädt, werden diese Antworten zur Fehlersuche mitgeschrieben.
const jsonHits = [];
page.on("response", async r => {
  if ((r.headers()["content-type"] || "").includes("json")) {
    try { jsonHits.push({ url: r.url(), body: await r.json() }); } catch {}
  }
});

await page.goto(URL + "#schedule", { waitUntil: "networkidle", timeout: 60000 });
await page.click('a[href="#schedule"]', { timeout: 5000 }).catch(() => {});
await page.waitForTimeout(3000);

// Alle Tabellenzeilen im Spielplan-Bereich als Zellen-Texte einsammeln.
const rowData = await page.evaluate(() => {
  const root = document.querySelector("#schedule") || document.body;
  const link = el => ([...el.querySelectorAll('a[href*="game_report"]')][0] || {}).href || "";
  let els = [...root.querySelectorAll("tr")];
  let r = els.map(tr => ({ cells: [...tr.querySelectorAll("td,th")].map(td => td.innerText.trim()), report: link(tr) }));
  if (!r.some(x => x.cells.length > 2)) { // keine Tabelle → Kartenlayout: Kind-Elemente als Zellen
    els = [...root.querySelectorAll("li, .game, .match, .row, article")];
    r = els.map(el => ({ cells: el.innerText.split("\n").map(s => s.trim()).filter(Boolean), report: link(el) }));
  }
  return r.filter(x => x.cells.length);
});
const rows = rowData.map(x => x.cells);

// Offizielle Tabelle (Reiter "Tabelle" / #standings)
await page.click('a[href="#standings"]', { timeout: 5000 }).catch(() => {});
await page.waitForTimeout(2000);
const standRows = await page.evaluate(() => {
  const root = document.querySelector("#standings");
  if (!root) return [];
  return [...root.querySelectorAll("tr")].map(tr => [...tr.querySelectorAll("td,th")].map(td => td.innerText.trim()));
});

// Topscorer (Reiter "Scorer" / #scorer) – nur was der EHV auch veröffentlicht
await page.click('a[href="#scorer"]', { timeout: 5000 }).catch(() => {});
await page.waitForTimeout(2000);
const scorerRaw = await page.evaluate(() => {
  const root = document.querySelector("#scorer");
  if (!root) return { text: "", rows: [] };
  return { text: root.innerText.slice(0, 2000), rows: [...root.querySelectorAll("tr")].map(tr => [...tr.querySelectorAll("td,th")].map(td => td.innerText.trim())) };
});

// Bad Boys / Strafminuten (Reiter "Bad Boys" / #badboys) – nur was der EHV veröffentlicht
await page.click('a[href="#badboys"]', { timeout: 5000 }).catch(() => {});
await page.waitForTimeout(2000);
const badRaw = await page.evaluate(() => {
  const root = document.querySelector("#badboys");
  if (!root) return { text: "", rows: [] };
  return { text: root.innerText.slice(0, 2000), rows: [...root.querySelectorAll("tr")].map(tr => [...tr.querySelectorAll("td,th")].map(td => td.innerText.trim())) };
});

// Bad Boys auswerten: Platz, Name, Team, Spiele, Strafminuten (letzte Zahl der Zeile)
const badboysRestricted = /keine Genehmigung/i.test(badRaw.text);
const badboys = [];
if (!badboysRestricted) for (const cells of badRaw.rows) {
  const rank = parseInt(cells.find(c => /^\d+\.?$/.test(c)), 10);
  const texts = cells.map((c, i) => [c, i]).filter(([c]) => /[A-Za-zÄÖÜäöüß]{2,}/.test(c));
  if (!rank || texts.length < 2) continue;
  const [name, ni] = texts.find(([c]) => /[ ,]/.test(c.trim())) || texts[0];
  const team = (texts.find(([c, i]) => i !== ni) || [""])[0];
  const nums = cells.slice(Math.max(ni, cells.indexOf(team)) + 1).filter(c => /^\d+$/.test(c)).map(Number);
  if (!nums.length) continue;
  badboys.push({ rank, name, team, gp: nums.length > 1 ? nums[0] : null, pim: nums[nums.length - 1] });
}

// Scorer auswerten: Platz, Name, Team, Spiele, Tore, Assists, Punkte
const scorersRestricted = /keine Genehmigung/i.test(scorerRaw.text);
const scorers = [];
if (!scorersRestricted) for (const cells of scorerRaw.rows) {
  const rank = parseInt(cells.find(c => /^\d+\.?$/.test(c)), 10);
  const texts = cells.map((c, i) => [c, i]).filter(([c]) => /[A-Za-zÄÖÜäöüß]{2,}/.test(c));
  if (!rank || texts.length < 2) continue;
  const [name, ni] = texts.find(([c]) => /[ ,]/.test(c.trim())) || texts[0];
  const team = (texts.find(([c, i]) => i !== ni) || [""])[0];
  const nums = cells.slice(Math.max(ni, cells.indexOf(team)) + 1).filter(c => /^\d+$/.test(c)).map(Number);
  if (nums.length < 3) continue;
  const [gp, g, a, pts] = nums.length >= 4 ? nums : [null, ...nums];
  scorers.push({ rank, name, team, gp, g, a, pts: pts ?? (g + a) });
}

// Tabellenzeilen auswerten: Platz, Team-Kürzel, Spiele, Tordifferenz, Punkte
const standings = [];
for (const cells of standRows) {
  const rank = parseInt(cells.find(c => /^\d+\.?$/.test(c)), 10);
  const ti = cells.findIndex(c => /[A-Za-zÄÖÜäöü]{2,}/.test(c));
  if (!rank || ti < 0) continue;
  const nums = cells.slice(ti + 1).filter(c => /^[+\-–]?\d+$/.test(c.replace(/\s/g, "")));
  if (nums.length < 2) continue;
  const n = x => parseInt(x.replace(/[–\s]/g, m => m === "–" ? "-" : ""), 10);
  const diffCell = cells.slice(ti + 1).find(c => /^[+\-–]\d+$/.test(c.replace(/\s/g, ""))) ?? (nums.length >= 3 ? nums[nums.length - 2] : "0");
  standings.push({ rank, team: cells[ti], gp: n(nums[0]), diff: n(diffCell), pts: n(nums[nums.length - 1]) });
}

const pad = n => String(n).padStart(2, "0");
const isWeekday = s => /^(mo|di|mi|do|fr|sa|so)\.?,?$/i.test(s);
const games = [];
for (const [ri, cells] of rows.entries()) {
  const reportUrl = rowData[ri].report;
  const txt = cells.join(" | ");
  const dm = txt.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})?/);
  if (!dm) continue;
  const day = +dm[1], mon = +dm[2];
  let year = dm[3] ? +(dm[3].length === 2 ? "20" + dm[3] : dm[3]) : (mon >= 7 ? SEASON_START_YEAR : SEASON_START_YEAR + 1);
  const tm = txt.match(/\b([01]?\d|2[0-3]):([0-5]\d)\s*(Uhr)?/);
  const time = tm ? `${pad(tm[1])}:${tm[2]}` : "00:00";
  // Ergebnis: x:y, das nicht die Uhrzeit ist (z. B. "4:3", "4:3 n.V.", "4 : 3 PS")
  const rest = tm ? txt.replace(tm[0], " ") : txt;
  const sm = rest.match(/(?:^|[^\d.:])(\d{1,2})\s*:\s*(\d{1,2})(?![\d.:])\s*(n\.?\s?V\.?|OT|PS|SO|Penalty)?/i);
  // Mannschaften = Zellen mit Buchstaben, die kein Datum/Wochentag/Ergebnis/Status sind
  const named = cells.filter(c => /[A-Za-zÄÖÜäöü]{3,}/.test(c) && !isWeekday(c) && !/^(\d|Uhr|Spiel\s*Nr|Bericht|Details|abgesagt|verlegt)/i.test(c));
  if (named.length < 2) continue;
  const [home, away, venue = ""] = named;
  // Spiel-ID = UUID im Bericht-Link (die Zahl am Ende ist für alle Spiele der Liga gleich)
  const nr = (reportUrl.match(/game_report\/([0-9a-f-]{36})/i) || [])[1] || (txt.match(/\b(\d{3,6})\b/) || [])[1];
  games.push({
    id: nr || `${year}${pad(mon)}${pad(day)}-${home}`.replace(/\W+/g, "-"),
    date: `${year}-${pad(mon)}-${pad(day)}T${time}`,
    home, away, venue,
    result: sm && !/abgesagt|verlegt/i.test(txt) ? { home: +sm[1], away: +sm[2], ot: !!sm[3] } : null,
    status: /abgesagt/i.test(txt) ? "abgesagt" : /verlegt/i.test(txt) ? "verlegt" : "",
    reportUrl
  });
}

// Spielberichte der eigenen Spiele (nur gespielte Spiele mit Bericht-Link)
const OUR = (process.env.OUR_TEAM || "BKM,Bergkamen").split(",").map(x => x.trim().toLowerCase());
const isOur = n => OUR.some(m => n.toLowerCase() === m || (m.length > 4 && n.toLowerCase().includes(m)));
const reportsDebug = [];
for (const g of games) {
  if (!g.reportUrl || !g.result || !(isOur(g.home) || isOur(g.away))) continue;
  try {
    await page.goto(g.reportUrl, { waitUntil: "networkidle", timeout: 45000 });
    await page.waitForTimeout(1500);
    const rep = await page.evaluate(() => {
      const main = document.querySelector("main, #content, .content") || document.body;
      return {
        text: main.innerText.slice(0, 8000),
        tables: [...main.querySelectorAll("table")].map(t => [...t.querySelectorAll("tr")].map(tr => [...tr.querySelectorAll("td,th")].map(td => td.innerText.trim()))),
        login: !!document.querySelector('input[type="password"]')
      };
    });
    const restricted = /keine Genehmigung/i.test(rep.text);
    // Drittelergebnisse, z. B. "(2:1, 0:3, 4:1)"
    const pm = rep.text.match(/\(\s*\d+\s*:\s*\d+(?:\s*[,;|]\s*\d+\s*:\s*\d+){1,4}\s*\)/);
    const periods = pm ? pm[0].replace(/[()\s]/g, "").split(/[,;|]/).filter(Boolean) : [];
    // Torfolge: Zeilen mit Spielzeit (mm:ss) und Spielstand (x:y)
    const goals = [];
    rep.tables.flat().forEach(cells => {
      const t = cells.find(c => /^\d{1,2}:\d{2}$/.test(c));
      const sc = cells.find(c => c !== t && /^\d{1,2}\s*:\s*\d{1,2}$/.test(c));
      if (!t || !sc) return;
      const team = cells.find(c => c === g.home || c === g.away) || "";
      const scorer = restricted ? "" : (cells.find(c => c !== team && /[A-Za-zÄÖÜäöüß]{3,}/.test(c) && !/^(PP|SH|EN|GWG|PS|EQ)\d?$/i.test(c)) || "");
      goals.push({ time: t, score: sc.replace(/\s/g, ""), team, scorer });
    });
    g.report = { periods, goals, restricted, available: !rep.login && (periods.length > 0 || goals.length > 0) };
    reportsDebug.push({ url: g.reportUrl, login: rep.login, text: rep.text.slice(0, 1000), tables: rep.tables.slice(0, 4) });
  } catch (e) { g.report = { available: false }; reportsDebug.push({ url: g.reportUrl, error: String(e).slice(0, 200) }); }
}
await browser.close();

fs.mkdirSync("data", { recursive: true });
fs.writeFileSync("data/ehv-debug.json", JSON.stringify({ url: URL, at: new Date().toISOString(), rows: rows.slice(0, 80), standRows: standRows.slice(0, 30), scorerRaw: { text: scorerRaw.text.slice(0, 500), rows: scorerRaw.rows.slice(0, 30) }, badRaw: { text: badRaw.text.slice(0, 500), rows: badRaw.rows.slice(0, 30) }, reports: reportsDebug.slice(0, 5), json: jsonHits.slice(0, 5) }, null, 2));

if (!games.length) {
  await browser.close().catch(() => {});
  console.error("Keine Spiele erkannt – vorhandene spielplan.json bleibt unverändert. Siehe data/ehv-debug.json.");
  process.exit(1);
}
games.sort((a, b) => a.date.localeCompare(b.date));
fs.writeFileSync(OUT, JSON.stringify({ updated: new Date().toISOString(), source: URL, standings, scorers, scorersRestricted, badboys, badboysRestricted, games }, null, 2));
console.log(`${games.length} Spiele, ${standings.length} Tabellenplätze, ${scorers.length} Scorer${scorersRestricted ? " (nicht freigegeben)" : ""}, ${badboys.length} Bad Boys${badboysRestricted ? " (nicht freigegeben)" : ""} nach ${OUT} geschrieben.`);
