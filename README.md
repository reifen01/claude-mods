# Claude-Code-Mods

## token-weather

Ein Wetterbericht für das Kontextfenster, als Zeile über dem Claude-Code-Prompt. Er aktualisiert sich nach jeder Runde.

```
☂ Regenschauer  67% · 134,4k / 200k  ▂▆  ▲ +98,3k letzte Runde
```

| Füllstand | Anzeige |
|---|---|
| unter 25 % | ☀ Heiter (gelb) |
| 25–49 % | ☁ Bewölkt (cyan) |
| 50–74 % | ☂ Regenschauer (blau) |
| 75–89 % | ☇ Gewitter (magenta) |
| ab 90 % | ↯ Bald komprimieren (rot) |

Danach folgen der Füllstand in Prozent, die belegten Tokens von der Fenstergröße, ein Verlauf der letzten 12 Runden (jeder Balken gemessen am ganzen Fenster) und der Zuwachs der letzten Runde. Nach einem Komprimieren zeigt er ▼ und den Rückgang.

### Installieren

Benötigt eine Claude-Code-Version mit Mod-Unterstützung (Function Hooks).

```
/plugin marketplace add reifen01/claude-mods
/plugin install token-weather@reifen01-mods
```

### Wie es funktioniert

- `session.measure`: Die Engine misst nach jeder Runde; ändert sich der Kontext, speichert der Mod den neuen Stand. Kostet keine Tokens.
- `$.state`: Die letzten 12 Stände, das Fenster und der Zuwachs. Ein Schreiben zeichnet die Zeile neu.
- `ui.render` auf `AbovePrompt`: zeichnet die Zeile unter dem, was andere Plugins dort zeichnen.

### Tests

```
claude plugin test plugins/token-weather
```

## Lizenz

MIT
