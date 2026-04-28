# MLB Stats Bot

MLB Stats Bot adalah bot Telegram untuk membantu membaca slate pertandingan MLB secara cepat. Bot ini mengambil data MLB, menghitung baseline prediction, lalu memberi ruang untuk Analyst Agent berbasis LLM agar membuat analisa final yang lebih kontekstual.

Output utama bot:

- Pre-game alert setiap pertandingan.
- Persentase kemenangan tiap tim.
- Alasan pick dari Analyst Agent.
- Analisa "Will there be a run in the 1st inning?" atau YRFI/NRFI.
- Post-game recap dan memory learning.
- Tanya jawab interaktif di Telegram.

> Catatan: bot ini adalah alat analisa dan edukasi. Probabilitas yang ditampilkan adalah estimasi model, bukan kepastian hasil.

## Cara Kerja

Alur sederhana:

```text
MLB StatsAPI
  -> baseline model
  -> Analyst Agent
  -> Telegram alert
  -> post-game evaluator
  -> memory update
```

Data yang dianalisa:

- Schedule, venue, probable pitcher.
- Team batting dan pitching.
- Standings, home/road, last 10, streak, run differential, expected W-L.
- Head-to-head musim berjalan.
- First inning scored/allowed profile.
- Bullpen fatigue 3 hari terakhir.
- Injury report 40-man roster dari MLB StatsAPI.
- Starting pitcher last 5 starts.
- Splits vs LHP/RHP.
- Post-game memory dari pick sebelumnya.

## Fitur Utama

- Telegram bot command-based dan chat interaktif.
- Analyst Agent dengan playbook `mlb-analyst-v1.1`.
- Support OpenAI-compatible API key.
- Support OpenRouter-style model seperti `openai/gpt-4o-mini`.
- Auto-alert harian.
- Post-game recap otomatis.
- Memory learning untuk full-game pick dan YRFI/NRFI.
- Python ML engine berbasis CSV lokal untuk Pythagorean, Log5, odds edge, dan model sklearn opsional.
- Terminal hanya untuk log, bukan output utama.

## Requirements

- Node.js `18.15+`
- Python `3.10+` untuk ML engine opsional
- Git
- Telegram bot token dari `@BotFather`
- OpenAI/OpenRouter API key jika ingin memakai Analyst Agent

Bot Telegram tidak perlu dependency tambahan karena memakai Node.js built-in `fetch`. Python ML engine memakai `requirements.txt` jika kamu ingin menjalankan training sklearn.

## Install Dari GitHub

Clone repository:

```bash
git clone https://github.com/grahito12/MLB-Stats-Bot.git
cd MLB-Stats-Bot
```

Cek versi Node:

```bash
node --version
```

Cek syntax project:

```bash
npm run check
```

## Setup Telegram Bot

1. Buka Telegram.
2. Chat ke `@BotFather`.
3. Kirim command:

```text
/newbot
```

4. Ikuti instruksi sampai mendapat bot token.
5. Copy `.env.example` menjadi `.env`.

Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Linux/macOS:

```bash
cp .env.example .env
```

6. Isi token di `.env`:

```env
TELEGRAM_BOT_TOKEN=isi_token_botfather
```

7. Jalankan bot:

```bash
npm start
```

8. Buka bot Telegram kamu, kirim:

```text
/chatid
```

9. Copy angka chat id ke `.env`:

```env
TELEGRAM_CHAT_ID=123456789
```

10. Restart bot:

```bash
npm start
```

## Konfigurasi .env

Minimal:

```env
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
TIMEZONE=Asia/Jakarta
```

Analyst Agent:

```env
OPENAI_API_KEY=
OPENAI_BASE_URL=
OPENAI_MODEL=gpt-4.1-mini
ANALYST_AGENT=true
ANALYST_AGENT_MODE=local
```

Jika memakai OpenRouter:

```env
OPENAI_API_KEY=sk-or-...
OPENAI_MODEL=openai/gpt-4o-mini
```

Auto-alert:

```env
AUTO_ALERTS=true
DAILY_ALERT_TIME=20:00
```

Auto update juga bisa diatur langsung dari Telegram tanpa edit `.env`:

```text
/autoupdate on
/autoupdate off
/autoupdate time 20:00
/autoupdate status
```

Setting ini disimpan per chat di `data/state.json`.

Post-game learning:

```env
POST_GAME_ALERTS=true
POST_GAME_POLL_MINUTES=5
MODEL_MEMORY=true
```

Interaktif di Telegram:

```env
INTERACTIVE_AGENT=true
PRINT_ALERT_TO_TERMINAL=false
```

Detail alert:

```env
ALERT_DETAIL=compact
```

atau:

```env
ALERT_DETAIL=full
```

## Menjalankan Bot

Mode polling Telegram:

```bash
npm start
```

Test sekali:

```bash
npm run once
```

Validasi syntax:

```bash
npm run check
```

Jika `PRINT_ALERT_TO_TERMINAL=false`, terminal hanya menampilkan log ringkas. Output utama dikirim ke Telegram.

## Python ML Prediction Engine

Selain bot Telegram, project ini punya engine Python lokal untuk eksperimen model MLB dari CSV.

Install dependency Python:

```bash
python -m pip install -r requirements.txt
```

Jalankan sample prediction:

```bash
python -m src.predict --home "Los Angeles Dodgers" --away "New York Yankees"
```

Dengan odds market:

```bash
python -m src.predict --home "Los Angeles Dodgers" --away "New York Yankees" --home-odds -120
```

Dengan total runs / over-under:

```bash
python -m src.predict --home "Los Angeles Dodgers" --away "New York Yankees" --market-total 8.5 --over-odds -110 --under-odds -110
```

Jalankan dari Telegram:

```text
/predict
/predict 2026-04-27
/predict Los Angeles Dodgers | New York Yankees
/predict Los Angeles Dodgers | New York Yankees | -120
/predict Los Angeles Dodgers | New York Yankees | decimal 1.91
```

Format Telegram:

```text
/predict
/predict HOME | AWAY | odds_home_opsional
```

Jika `/predict` dikirim tanpa matchup, bot menampilkan semua game MLB dari MLB StatsAPI live schedule pada tanggal tersebut. Setelah tombol dipilih, bot memakai prediction model/Agent dari data live. Di bawah hasil prediction ada tombol `Total 6.5`, `Total 7.5`, `Total 8.5`, `Total 9.5`, `Total 10.5`, dan `Total 11.5` untuk membandingkan projected total dengan market total yang kamu pilih. Format manual tetap memakai Python ML engine dan CSV lokal.

Output tombol `/predict` juga menampilkan total runs live:

```text
Total Runs / Over-Under
Projection
• Projected total: 9.9 runs
• Expected runs: MIA 4.0 | LAD 5.9
• Market total: 8.5 (+1.4 runs vs model)
• Best lean: Over 8.5 (high)

Over Probability
• Over 6.5: 86%
• Over 7.5: 77%
• Over 8.5: 65%
• Over 9.5: 53%
• Over 10.5: 40%
• Over 11.5: 29%

Under Probability
• Under 6.5: 14%
• Under 7.5: 23%
• Under 8.5: 35%
• Under 9.5: 47%
• Under 10.5: 60%
• Under 11.5: 71%

Run Drivers
• Offense: +0.3
• Starting pitcher: +0.4
• Bullpen: +0.2
• Weather: +0.0
• Lineup: +0.1

Context
• Park: Dodger Stadium (Run PF 99, HR PF 102)
• MIA: confirmed 9/9
• LAD: confirmed 9/9
```

Jika Python di mesin kamu bukan `python`, atur di `.env`:

```env
PYTHON_BIN=python
```

Output berisi:

```text
Home Team: Los Angeles Dodgers
Away Team: New York Yankees
Predicted Winner: Los Angeles Dodgers
Home Win Probability: 55.9%
Away Win Probability: 44.1%
Confidence: Medium
Main Factors:
- Better Log5/Pythagorean team-strength profile
- Better starting pitcher advantage
- Stronger bullpen profile
```

Model logic:

- Pythagorean Win%: mengukur kekuatan tim dari run scored dan run allowed.
- Log5: mengubah kekuatan dua tim menjadi probabilitas matchup.
- Starting pitcher score: ERA, WHIP, FIP, dan K/BB.
- Offense score: OPS, wRC+, dan runs per game.
- Bullpen score: bullpen ERA, WHIP, dan recent usage.
- Recent form: last 5-10 games dengan run differential.
- Home field: edge kecil untuk home team.
- Odds edge: model probability dikurangi implied probability market.

Total runs logic:

- Projected total = league average total runs + offense + starting pitcher + bullpen + park + weather + lineup + recent form + optional umpire adjustment.
- Over/under probability dihitung dari projected total memakai Poisson dan negative binomial style over-dispersion.
- Market edge = model probability dikurangi implied probability dari odds market.
- `Over 8.5: 56%` artinya model memperkirakan peluang total run selesai 9+ sekitar 56%.
- Projected total bisa berbeda dari market total karena model memberi bobot ke SP, bullpen fatigue, cuaca, park factor, lineup, dan recent run form.
- Untuk Telegram live, lineup diambil dari MLB boxscore jika sudah diumumkan. Jika belum ada, bot tetap memakai baseline offense/injury/recent form.
- Park factor Telegram memakai baseline internal per ballpark agar tetap jalan tanpa API berbayar; file Python `src/park_factors.py` tetap bisa diganti dengan data park factor yang lebih baru.

## MLB Data And Knowledge Layer

Project ini sekarang punya layer Python tambahan untuk membuat Analyst Agent lebih pintar tanpa membuat bot bergantung pada API berbayar. Default tetap memakai CSV lokal, sedangkan sumber eksternal bisa diaktifkan opsional.

Data sources:

- `src/data_sources/pybaseball_client.py`: adapter optional untuk `pybaseball`, Statcast, Baseball Savant, FanGraphs, Baseball Reference, batting stats, pitching stats, team stats, dan historical data.
- `src/data_sources/mlb_statsapi_client.py`: MLB Stats API langsung untuk schedule, game status, teams, players, probable pitchers, boxscore, live feed, standings, dan rosters.
- `src/data_sources/retrosheet_loader.py`: loader Retrosheet-style game logs dan play-by-play dari CSV lokal.
- `src/data_sources/statcast_loader.py`: loader Baseball Savant / Statcast CSV dengan exit velocity, launch angle, xwOBA, xBA, xSLG, hard-hit rate, barrel rate, pitch type, pitch velocity, dan pitcher movement.
- `src/data_sources/odds_client.py`: optional The Odds API untuk moneyline, run line, totals, over odds, under odds, opening/current line, dan market movement.
- `src/data_sources/weather_client.py`: optional OpenWeather atau NOAA/NWS untuk temperature, wind, humidity, air pressure, dan rain/weather context.
- `src/data_sources/cache.py`: cache lokal di `data/cache/` supaya request tidak agresif dan tidak mengulang panggilan API yang sama.

Knowledge/RAG-style modules:

- `src/knowledge/baseball_knowledge.py`
- `src/knowledge/retriever.py`
- `data/knowledge/sabermetrics_glossary.md`
- `data/knowledge/mlb_prediction_rules.md`
- `data/knowledge/betting_market_explainer.md`
- `data/knowledge/over_under_modeling.md`

Agent tools:

```python
from src.agent_tools import (
    get_today_games,
    get_game_context,
    get_probable_pitchers,
    get_team_recent_form,
    get_pitcher_recent_form,
    get_team_offense_splits,
    get_bullpen_usage,
    get_park_factor,
    get_weather_context,
    get_market_odds,
    predict_moneyline,
    predict_total_runs,
    explain_prediction,
)

print(explain_prediction(0))
```

Contoh knowledge question:

```python
from src.knowledge.baseball_knowledge import answer_baseball_question

answer = answer_baseball_question("Why is FIP better than ERA for pitcher prediction?")
print(answer["answer"])
print(answer["sources"])
```

Optional API keys di `.env`:

```env
ODDS_API_KEY=
THE_ODDS_API_KEY=
OPENWEATHER_API_KEY=
```

Optional pybaseball install:

```bash
pip install pybaseball
```

Prinsip penting:

- Jangan scrape website agresif.
- Hormati rate limit dan terms setiap API.
- External APIs optional; CSV sample tetap menjadi fallback.
- Rolling stats untuk backtest harus digeser sebelum game target agar tidak data leakage.
- Market odds dipakai untuk edge, bukan untuk menjamin hasil.

Baseline weight:

```text
30% Log5 / Pythagorean team strength
25% Starting pitcher strength
20% Team offense
10% Bullpen strength
10% Recent form
5% Home field advantage
```

Training ML opsional tersedia di `src/model.py` lewat `train_ml_models()`:

```python
from src.model import shift_rolling_averages, train_ml_models

rows = [
    {"team": "LAD", "date": "2025-04-01", "ops": 0.760, "home_win": 1},
    {"team": "LAD", "date": "2025-04-02", "ops": 0.780, "home_win": 0},
]
safe_rows = shift_rolling_averages(rows, "team", "date", ["ops"], window=5)
models = train_ml_models(safe_rows, ["ops_rolling_5"], "home_win")
```

`shift_rolling_averages()` sengaja memakai data sebelum tanggal game agar tidak terjadi data leakage.

Sample CSV:

```text
data/sample_games.csv
data/sample_team_stats.csv
data/sample_pitcher_stats.csv
data/sample_weather.csv
data/sample_park_factors.csv
data/sample_bullpen_usage.csv
data/sample_lineups.csv
data/sample_market_totals.csv
```

Test Python:

```bash
python -m unittest discover -s tests
```

Catatan: ini bukan betting advice. MLB punya variance tinggi, dan probabilitas model bukan jaminan hasil.

## Command Telegram

```text
/start
/help
/today
/deep
/date 2026-04-27
/game Yankees
/predict
/predict Los Angeles Dodgers | New York Yankees
/predict Los Angeles Dodgers | New York Yankees | -120
/ask game mana yang edge-nya paling kuat hari ini?
/agent
/skill
/postgame 2026-04-27
/memory
/autoupdate on
/autoupdate time 20:00
/subscribe
/unsubscribe
/sendalert
/chatid
```

Kamu juga bisa langsung bertanya tanpa slash:

```text
kenapa Dodgers dipilih?
upset risk terbesar hari ini?
bandingkan Yankees vs Rangers
```

## Contoh Output

```text
MLB Pre-game Alert
2026-04-27

━━━━━━━━━━━━━━━━━━━━

Yankees @ Rangers

────────────
Probabilitas
Agent: NYY 70% | TEX 30%
Baseline: NYY 70% | TEX 30%

────────────
Pick Agent: New York Yankees

────────────
Context
- NYY 18-10, L10 8-2, road 10-5
- TEX 14-14, L10 5-5, home 6-6

Bullpen
- NYY bullpen fatigue high
- TEX bullpen fatigue medium

First Inning
Will there be a run in the 1st? YES / YRFI 54%
```

## Analyst Agent

Agent memakai playbook:

```text
mlb-analyst-v1.1
```

Playbook ada di:

```text
docs/analyst-playbook.md
```

Prinsip analisa:

- Baseline model hanya prior.
- Agent boleh override baseline jika data mendukung.
- Pisahkan process vs noisy outcome.
- Starter recent form penting.
- Bullpen fatigue memengaruhi risk.
- H2H dipakai hati-hati karena sample kecil.
- First inning dianalisa terpisah dari full-game pick.
- Injury report dipakai sebagai availability risk, terutama hitter inti, starter, catcher, dan reliever leverage.
- Memory adalah sinyal kecil, bukan penentu utama.

ML reference layer yang ikut masuk ke Agent:

- Ensemble agreement dari beberapa sinyal, bukan satu angka saja.
- Pythagorean expectation untuk melihat regression risk.
- Log5 untuk prior matchup dari kekuatan dua tim.
- Recent window last 5-10 games dan last 3-5 starter starts.
- Anti data leakage: tidak memakai data yang belum tersedia sebelum game.
- Market-edge thinking jika odds/implied probability ditambahkan dari external agent.
- Score/run thinking sebagai pendukung full-game dan YRFI/NRFI.

Referensi GitHub yang dipakai sebagai inspirasi metodologi:

- https://github.com/whrg/MLB_prediction
- https://github.com/andrew-cui-zz/mlb-game-prediction
- https://github.com/Forrest31/Baseball-Betting-Model
- https://github.com/kylejohnson363/Predicting-MLB-Games-with-Machine-Learning
- https://github.com/laplaces42/mlb_game_predictor

## First Inning / YRFI-NRFI

Setiap game punya pertanyaan:

```text
Will there be a run in the 1st inning?
```

Verdict:

- `YES / YRFI`: ada kecenderungan run di inning pertama.
- `NO / NRFI`: condong tidak ada run di inning pertama.

Sinyal yang dipakai:

- Team scored 1st inning.
- Team allowed 1st inning.
- Recent any-run first inning.
- H2H first-inning run.
- Starting pitcher hari itu.

## Post-game Memory

Saat game final:

1. Bot membaca hasil akhir.
2. Membandingkan pick agent vs winner aktual.
3. Membandingkan YRFI/NRFI vs first inning aktual.
4. Menyimpan hasil ke `data/state.json`.
5. Mengirim post-game recap ke Telegram.

Cek memory:

```text
/memory
```

Memory yang disimpan:

- Full-game accuracy.
- Accuracy per confidence bucket.
- YRFI/NRFI accuracy.
- Recent learning log.
- Bias kecil per team.

## External Agent Mode

Jika kamu punya AI Agent sendiri lewat API:

```env
ANALYST_AGENT_MODE=external
ANALYST_AGENT_URL=http://localhost:8000/mlb/analyze
ANALYST_AGENT_API_KEY=
```

Endpoint akan menerima JSON berisi:

- `task`
- `skillVersion`
- `analystPlaybook`
- `memory`
- `games`
- `modelReference` di setiap game: Pythagorean dan Log5 signals
- `outputContract`

Expected response:

```json
{
  "analyses": [
    {
      "gamePk": 123,
      "pickTeamId": 147,
      "awayProbability": 42,
      "homeProbability": 58,
      "confidence": "medium",
      "reasons": ["..."],
      "risk": "...",
      "memoryNote": "...",
      "firstInning": {
        "pick": "YES",
        "probability": 54,
        "confidence": "medium",
        "reasons": ["..."],
        "risk": "..."
      }
    }
  ]
}
```

## File Penting

```text
src/index.js          Bot Telegram, scheduler, command handler
src/mlb.js            Data MLB, baseline model, formatter alert
src/llm.js            Analyst Agent local/external
src/storage.js        Memory dan state
src/telegram.js       Telegram Bot API wrapper
src/analystSkill.js   Analyst playbook prompt
src/features.py       Formula sabermetric Python
src/model.py          Baseline prediction dan optional sklearn models
src/totals.py         Total runs dan over/under probabilities
src/weather.py        Weather run adjustment
src/park_factors.py   Park factor run adjustment
src/lineup.py         Lineup availability adjustment
src/bullpen.py        Bullpen fatigue adjustment
src/predict.py        CLI Python prediction
src/odds.py           Implied probability dan edge
src/data_loader.py    Loader CSV lokal
src/agent_tools.py    Tool layer untuk Agent context/prediction/explanation
src/data_sources/     Optional pybaseball, MLB StatsAPI, Retrosheet, Statcast, odds, weather clients
src/knowledge/        Local RAG-style baseball knowledge retriever
docs/analyst-playbook.md
data/knowledge/       Sabermetric, prediction, betting, dan over/under knowledge files
.env.example          Template konfigurasi
requirements.txt      Dependency Python opsional
tests/                Unit tests Python
```

## Data Sources

- MLB StatsAPI: schedule, standings, team stats, boxscore, linescore.
- MLB StatsAPI: 40-man roster injury status dan transactions untuk catatan cedera.
- Telegram Bot API.
- OpenAI-compatible API.
- MLB-StatsAPI GitHub endpoint references.
- FanGraphs/Statcast concepts for analyst playbook.
- MLB prediction GitHub references for Log5, Pythagorean expectation, ensemble modeling, odds edge, and score/run projection concepts.

## Security

Jangan commit `.env`.

File ini sudah di-ignore:

```text
.env
data/*.json
node_modules/
*.log
```

Jika API key pernah terlanjur ter-upload, segera revoke key tersebut dan buat key baru.

## Troubleshooting

Bot tidak membalas:

- Pastikan `npm start` masih berjalan.
- Cek `TELEGRAM_BOT_TOKEN`.
- Kirim `/chatid` dan isi `TELEGRAM_CHAT_ID`.
- Pastikan chat id kamu ada di `ALLOWED_CHAT_IDS` jika fitur itu dipakai.

Agent tidak muncul:

- Pastikan `ANALYST_AGENT=true`.
- Pastikan `OPENAI_API_KEY` terisi.
- Pastikan model cocok dengan provider.

Post-game tidak jalan:

- Pastikan pre-game alert sudah dibuat sebelum game final.
- Pastikan `POST_GAME_ALERTS=true`.
- Cek `/postgame YYYY-MM-DD`.

Auto update tidak terkirim:

- Cek `/autoupdate status`.
- Pastikan jam memakai format `HH:mm`, contoh `/autoupdate time 20:00`.
- Pastikan bot tetap berjalan dengan `npm start`.
