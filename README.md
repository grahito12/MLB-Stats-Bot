# MLB Stats Bot

MLB Stats Bot adalah bot Telegram untuk membantu membaca slate pertandingan MLB secara cepat. Bot ini mengambil data MLB, menghitung baseline prediction, lalu memberi ruang untuk Analyst Agent berbasis LLM agar membuat analisa final yang lebih kontekstual.

Output utama bot:

- Pre-game alert setiap pertandingan.
- Persentase kemenangan tiap tim.
- Alasan pick dari Analyst Agent.
- Post-game recap dan memory learning (moneyline).
- Tanya jawab interaktif di Telegram.

> Catatan: bot ini adalah alat analisa dan edukasi. Probabilitas yang ditampilkan adalah estimasi model, bukan kepastian hasil.

## Quick Start

```bash
git clone https://github.com/0x-zeze/MLB-Stats-Bot.git
cd MLB-Stats-Bot
cp .env.example .env
npm ci
npm --prefix dashboard-react ci
python3 -m pip install -r requirements.txt
npm run doctor
npm start
```

Untuk VPS production, gunakan [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Untuk memahami alur sistem, lihat [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Untuk metrik, keterbatasan, dan template backtest, lihat [docs/MODEL_CARD.md](docs/MODEL_CARD.md).

## Safety And Risk Disclaimer

Project ini tidak menjanjikan profit, akurasi tertentu, atau hasil betting yang pasti. Output harus dibaca sebagai analisis probabilistik. Guardrail penting:

- `NO BET` saat data quality rendah.
- `NO BET` saat lineup, pitcher, atau odds wajib sudah stale.
- Confidence cap untuk konteks staking.
- Flat stake default dan fractional Kelly opsional.
- Max daily exposure agar satu slate tidak mengambil risiko berlebihan.

Jangan pakai output sebagai guaranteed betting advice. Abaikan pick jika data lineup/pitcher/odds tidak bisa diverifikasi.

## Feature Status

| Area | Status | Notes |
| --- | --- | --- |
| Telegram commands and daily alerts | Stable | Core bot path. |
| MLB StatsAPI live schedule/context | Stable | External API availability can vary. |
| Moneyline and totals baseline models | Stable | Conservative deterministic logic. |
| Data quality and no-bet guardrails | Stable | Includes stale/missing data checks. |
| Dashboard API auth, CORS, rate limiting | Stable | Set `DASHBOARD_API_TOKEN` in production. |
| React dashboard | Experimental | Useful control center; verify API config before public exposure. |
| Prediction Audit Card (dashboard + Telegram `/auditcard`) | Stable | Inspect one immutable prediction end-to-end; read-only. |
| Immutable prediction history (`model_predictions`, snapshots) | Stable | Append-only; every prediction is reproducible. |
| Shadow challenger models (`learned_v2_logistic`, `market_residual_v2`) | Experimental | `MLB_SHADOW_MODE` off by default; never affect picks. |
| Chronological evaluation, OOF calibration, ablation, promotion reports | Experimental | Offline research tooling; no challenger promoted yet. |
| Analyst/LLM layer | Experimental | Optional; should not override safety rules. |
| Odds/weather enrichment | Experimental | Depends on optional provider keys. |
| Evolution/audit learning engine | Experimental | Audit-first; promotion requires validation. |
| Published model performance metrics | TODO | Use `docs/MODEL_CARD.md`; do not invent numbers. |

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
- Optional external MLB news context via permitted RSS/Atom feeds (verified: MLB Trade Rumors, CBS Sports MLB, Baseball America). Context display-only; tidak mengubah probabilitas.
- Starting pitcher last 5 starts.
- Splits vs LHP/RHP.
- Post-game memory dari pick sebelumnya.

## Fitur Utama

- Telegram bot command-based dan chat interaktif.
- Analyst Agent dengan playbook `mlb-analyst-v1.1`.
- Support OpenAI-compatible API key.
- Support OpenRouter-style model seperti `openai/gpt-4o-mini`.
- Auto-alert harian.
- Live odds line movement alert untuk moneyline dan total runs.
- Moneyline value engine dengan `VALUE / NO BET / LEAN ONLY` agar pick tidak bias ke probabilitas terbesar saja.
- Post-game recap otomatis.
- Memory learning untuk full-game (moneyline) pick.
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
git clone https://github.com/0x-zeze/MLB-Stats-Bot.git
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

## Telegram Webhook Mode

Default bot tetap memakai polling. Untuk VPS production, kamu bisa mengaktifkan webhook agar Telegram mengirim update langsung ke server bot.

Isi `.env`:

```env
TELEGRAM_WEBHOOK_MODE=true
TELEGRAM_WEBHOOK_URL=https://domain-kamu.com/telegram/webhook
TELEGRAM_WEBHOOK_PORT=8443
TELEGRAM_WEBHOOK_SECRET=ganti_dengan_random_secret_panjang
```

Catatan:

- `TELEGRAM_WEBHOOK_URL` adalah URL publik HTTPS yang bisa diakses Telegram.
- Jika kamu memakai reverse proxy di port 443, URL cukup `https://domain-kamu.com/telegram/webhook`.
- Jika kamu expose port 8443 langsung, URL harus memuat port: `https://domain-kamu.com:8443/telegram/webhook`.
- Server Node bot mendengarkan HTTP lokal di `TELEGRAM_WEBHOOK_PORT`; SSL sebaiknya ditangani Nginx/Caddy di depan bot.
- Header `X-Telegram-Bot-Api-Secret-Token` divalidasi memakai `TELEGRAM_WEBHOOK_SECRET`.

### SSL Dengan Let's Encrypt

Rekomendasi paling mudah adalah domain + Nginx + Let's Encrypt:

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo certbot --nginx -d domain-kamu.com
```

Contoh Nginx reverse proxy:

```nginx
server {
    listen 443 ssl;
    server_name domain-kamu.com;

    location /telegram/webhook {
        proxy_pass http://127.0.0.1:8443;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

Lalu jalankan:

```bash
npm start
```

### Port 8443

Jika benar-benar ingin membuka 8443 ke publik:

```bash
sudo ufw allow 8443/tcp
```

Namun Telegram tetap membutuhkan HTTPS di URL publik. Untuk direct 8443, jalankan reverse proxy SSL di port 8443 dan arahkan ke bot di port internal lain, atau pakai 443 seperti contoh di atas.

### Self-Signed SSL

Self-signed hanya cocok untuk setup lanjutan. Telegram perlu endpoint HTTPS valid atau certificate self-signed yang di-upload saat `setWebhook`. Implementasi bot ini memakai request JSON sederhana, jadi jalur yang direkomendasikan adalah Let's Encrypt. Jika tetap memakai self-signed, letakkan Nginx/Caddy sebagai TLS terminator dan pastikan Telegram dapat memverifikasi sertifikatnya.

### Verifikasi Webhook

Cek webhook aktif:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo"
```

Jika ingin kembali ke polling:

```env
TELEGRAM_WEBHOOK_MODE=false
```

Saat polling aktif, bot akan mencoba `deleteWebhook` otomatis agar `getUpdates` bisa berjalan lagi.

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

Setting ini disimpan per chat di `data/state.sqlite`.

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

Di Telegram, `/today` selalu memakai tampilan ringkas untuk semua game: matchup, waktu, stadion, probabilitas, dan pick model. Gunakan `/deep` jika ingin semua statistik lengkap untuk seluruh slate.

## Menjalankan Bot Dan Dashboard

Mode utama, cukup satu command untuk menjalankan Telegram bot, FastAPI API, dan React dashboard:

```bash
npm start
```

Output:

```text
Telegram bot: src/index.js
Dashboard Web: http://IP-VPS-KAMU:5173
Dashboard API: http://127.0.0.1:8010
```

Kalau hanya ingin menjalankan bot Telegram tanpa dashboard baru:

```bash
npm run bot
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

## Dashboard Web

Project ini juga punya dashboard lokal untuk memantau semua modul yang sudah dibangun:

- Schedule dan prediction slate.
- Moneyline probability.
- Total runs / over-under probability.
- Data quality score dan no-bet decision.
- Backtest, ROI, CLV, Brier, dan calibration report.
- Agent memory summary.
- Knowledge base sabermetrics.
- Status Telegram, OpenAI key, Analyst Agent, dan auto-alert.

Dashboard baru ikut menyala saat menjalankan command utama:

```bash
npm start
```

Kalau hanya ingin menjalankan dashboard baru tanpa bot Telegram:

```bash
npm run dashboard
```

Buka:

```text
http://localhost:5173
```

Jika berjalan di VPS, akses lewat browser:

```text
http://IP-VPS-KAMU:5173
```

Port dashboard baru bisa diganti di `.env`:

```env
DASHBOARD_API_HOST=127.0.0.1
DASHBOARD_API_PORT=8010
DASHBOARD_WEB_HOST=0.0.0.0
DASHBOARD_WEB_PORT=5173
# Required in production. Generate with: openssl rand -hex 32
DASHBOARD_API_TOKEN=
DASHBOARD_CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
# Optional dev-mode pre-fill for the React login field.
VITE_DASHBOARD_API_TOKEN=
```

Dashboard legacy lama masih tersedia kalau dibutuhkan:

```bash
npm run dashboard:legacy
```

Saat `npm start`, dashboard legacy port `3008` otomatis dimatikan supaya tidak membingungkan. Kalau benar-benar ingin legacy ikut menyala juga, jalankan dengan `START_LEGACY_DASHBOARD=true`.

Jika `http://localhost:5173` berhasil di VPS tetapi `http://IP-VPS-KAMU:5173` loading terus, biasanya port belum terbuka ke publik. Cek:

```bash
ss -ltnp | grep -E '5173|8010'
```

Output normal adalah frontend di `0.0.0.0:5173` dan FastAPI di `127.0.0.1:8010`; browser cukup membuka frontend, lalu Vite meneruskan request API secara lokal.

Lalu buka firewall VPS:

```bash
sudo ufw allow 5173/tcp
sudo ufw status
```

Jika memakai provider seperti AWS, DigitalOcean, Vultr, Hostinger, atau lainnya, pastikan inbound/security group juga membuka TCP port `5173`. Port `8010` hanya perlu dibuka jika API ingin diakses langsung dari luar.

Mode dashboard:

- `Live Games`: default. Memakai MLB StatsAPI live untuk schedule, status game, probable pitcher, lineup/boxscore context, bullpen context, injury context, dan model prediction pada tanggal yang dipilih.
- `Sample CSV`: fallback untuk tes Python prediction layer dari CSV lokal. Mode ini bukan jadwal live dan bisa berisi matchup contoh lama.

Kalau game di dashboard tidak sesuai jadwal hari ini, pastikan tab yang aktif adalah `Live Games`, bukan `Sample CSV`, lalu klik `Refresh`. Jika tidak ada game, dashboard akan menampilkan pesan kosong dari MLB StatsAPI untuk tanggal tersebut, bukan lagi diam-diam memakai sample data.

Catatan market: dashboard tidak mengarang odds. Jika `ODDS_API_KEY`/provider odds belum dikonfigurasi, bagian market akan ditandai sebagai unavailable/default baseline.

Fitur interaktif:

- Pilih tanggal.
- Pilih game.
- Pindah tab `Overview`, `Moneyline`, `Totals`, dan `Quality`.
- Jalankan backtest `moneyline` atau `totals`.
- Tanya knowledge base langsung dari dashboard.

## Dashboard Control Center FastAPI + React

Dashboard baru tersedia sebagai prediction control center profesional:

- Backend FastAPI: `src/dashboard_api.py`
- Service/business logic: `src/dashboard_service.py`
- Frontend React + Tailwind: `dashboard-react/`
- UI design system ala `shadcn/ui`: reusable `Button`, `Card`, `Badge`, `Input`, `Select`, `Progress`, dan `Switch`.
- Icons: `lucide-react`.
- Charts: `recharts` untuk performance, ROI, dan calibration view.
- Mock data: `data/dashboard_mock.json`
- Settings threshold lokal: `data/dashboard_settings.json`

Install dependency backend:

```bash
npm run setup:python
```

Install dependency frontend:

```bash
npm run setup:web
```

Atau install backend dan frontend sekaligus:

```bash
npm run setup
```

Jalankan dashboard baru dengan satu command:

```bash
npm run dashboard
```

URL default:

```text
Frontend: http://IP-VPS-KAMU:5173
FastAPI:  http://127.0.0.1:8010
```

Jika ingin menjalankan terpisah:

```bash
npm run dashboard:api
npm run dashboard:web
```

Live API:

- Tab `Today` default memakai `source=live`.
- FastAPI akan memanggil live prediction layer Node yang sudah ada (`src/dashboard.js` -> `getMlbPredictions`).
- Jika live data gagal, dashboard otomatis menampilkan mock data dan memberi warning, bukan menyembunyikan error.
- Pilihan source di UI: `Live`, `Sample`, dan `Mock`.

Export CSV:

```text
GET /api/export/today
GET /api/export/history
GET /api/export/performance
GET /api/export/backtest
```

Prediction audit API:

```text
GET /api/predictions/audit                      list prediksi immutable (filter ?date=&limit=)
GET /api/predictions/{prediction_id}/audit      payload audit ternormalisasi satu prediksi
```

Threshold bisa diubah dari tab `Settings`:

- Minimum moneyline edge.
- Minimum total edge.
- Minimum projected total difference.
- Minimum data quality score.
- Odds stale threshold.
- Weather stale threshold.
- Auto-refresh interval.
- Confidence thresholds.
- Toggle weather, umpire, dan market movement adjustment.

Catatan VPS:

- Buka port `5173/tcp` untuk frontend React.
- Jangan buka port `8010/tcp` kecuali benar-benar ingin API diakses langsung.
- Kalau hanya memakai Vite proxy dari frontend, browser cukup membuka port `5173`.
- Di production, set `DASHBOARD_API_TOKEN` di backend; `VITE_DASHBOARD_API_TOKEN` hanya untuk pre-fill login saat development.

## Model Lifecycle Dan Prediction Audit

Bot ini tidak lagi sekadar `data -> heuristic -> pick`. Setiap prediksi produksi sekarang melewati jalur yang bisa diaudit:

```text
immutable snapshot
  -> feature vector (frozen)
  -> control model (heuristic_v1)
  -> shadow challengers (opsional, tidak memengaruhi pick)
  -> calibration (versioned)
  -> decision (VALUE / LEAN ONLY / NO BET)
  -> settlement + closing line (CLV)
  -> chronological evaluation
```

Komponen utama:

- **Immutable history**: setiap prediksi tercatat append-only di `model_predictions` (satu baris per run per model) dengan probabilitas raw/calibrated/display terpisah, versi model+fitur+kalibrasi, snapshot hash, dan status kelayakan promosi. Snapshot lengkap tersimpan di `data/prediction_snapshots/`.
- **Market quote pairs**: odds home/away satu bookmaker disimpan dengan timestamp (`market_quote_pairs`); quote setelah first pitch ditandai ineligible. Opening dan closing dipisahkan — closing hanya untuk evaluasi/CLV, tidak pernah jadi input model.
- **Shadow models**: `learned_v2_logistic` dan `market_residual_v2` bisa menilai snapshot yang sama dengan control (`MLB_SHADOW_MODE=true`, default off). Shadow tidak pernah mengubah pick, stake, Telegram, atau dashboard.
- **Evaluasi kronologis**: train/validation/holdout berbasis tanggal (bukan random split), OOF calibration, ablation engine, dan promotion report berbasis bukti (`src/eval/`). Belum ada challenger yang dipromosikan; `heuristic_v1` tetap control.

Dokumen terkait: `docs/PREDICTION_ARCHITECTURE.md`, `docs/CURRENT_MODEL_FORMULA.md`, `docs/EVALUATION_METHOD.md`, `docs/CALIBRATION_GOVERNANCE.md`, `docs/MODEL_GOVERNANCE.md`, `docs/REPLAY_ARCHITECTURE.md`, `docs/REMAINING_RISKS.md`.

### Prediction Audit Card

Setiap prediksi immutable bisa diinspeksi satu per satu — apa yang diketahui sistem saat itu, model mana yang menghasilkan probabilitas, kenapa BET/NO BET, dan apa hasilnya. Detail lengkap: [docs/PREDICTION_AUDIT_CARD.md](docs/PREDICTION_AUDIT_CARD.md).

Tiga akses:

- **Dashboard**: tab `Audit` — tabel prediksi immutable + kartu audit (bar probabilitas raw vs calibrated vs market no-vig, delta model−market, kontribusi fitur, data quality per input, alasan keputusan, hasil + CLV, identity + replay).
- **API**: `GET /api/predictions/audit` (list) dan `GET /api/predictions/{prediction_id}/audit` (payload ternormalisasi).
- **Telegram**: satu command untuk semuanya:

```text
/auditcard                     daftar prediksi immutable terbaru
/auditcard 2026-08-20          daftar untuk tanggal tertentu
/auditcard yankees             kartu audit lengkap untuk game tim itu
/auditcard 2026-08-20 dodgers  kombinasi tanggal + tim
```

Prinsip audit card:

- Tidak pernah mengarang data — field yang tidak terekam ditampilkan "tidak terekam" / "Not recorded".
- Market saat prediksi hanya memakai quote dengan `fetched_at <= as_of` (anti temporal leakage); closing line ditampilkan terpisah.
- Kontribusi fitur adalah dekomposisi exact dari formula produksi `heuristic_v1` — jumlah komponen sama dengan raw edge, diverifikasi.
- Probabilitas raw, calibrated, dan market tidak pernah dicampur jadi satu angka.

## MLB Agent Evolution Engine

The MLB Agent Evolution Engine is a lightweight, auditable learning layer for the prediction agent. It is inspired by self-evaluation and symbolic learning systems, but it is intentionally conservative: it records what happened, generates lessons, proposes improvements, and requires validation before anything can be promoted.

Important warning: this system is for analytics and education. It does not guarantee betting profit or sports prediction accuracy.

What it does:

- Logs pre-game prediction trajectories with model, prompt, rule, weight, data, tool, and decision context.
- Evaluates settled games against final results.
- Converts numeric misses and wins into structured language loss.
- Converts language loss into language gradients for prompt, rule, tool, threshold, and weighting candidates.
- Generates lessons and self-questions for review.
- Proposes symbolic update candidates without applying them directly.
- Requires backtest metrics and a promotion gate before approved changes are versioned.
- Shows the state in the dashboard `Evolution` tab.

What it does not do:

- It does not run heavy reinforcement learning.
- It does not overwrite production prompts, rules, or weights directly.
- It does not remove NO BET protections automatically.
- It does not train from unfinished games.
- It does not allow memory to override current validated game data.

Core flow:

```text
prediction trajectory
-> final result
-> numeric evaluation
-> language loss
-> language gradient
-> lesson
-> symbolic update candidate
-> backtest
-> promotion gate
-> versioned improvement
```

Trajectory logging means the bot stores only information available before the game: teams, market, probable pitcher status, lineup status, weather status, odds status, bullpen status, park factor status, data quality, tool calls, model features, probabilities, market lines, edge, lean, confidence, risk factors, and active prompt/rule/weight/model versions. Final score data is intentionally stripped from pre-game trajectories.

Language loss is a structured explanation of what went right or wrong, such as `overconfidence`, `weak_edge`, `lineup_misread`, `good_no_bet`, `bad_no_bet`, `weather_misread`, or `totals_projection_error`. Numeric facts come from deterministic evaluation; language is only used to summarize.

Language gradients turn those losses into improvement pressure, for example: cap confidence when totals edge is small and lineups are projected, require weather checks before outdoor totals picks, or clarify explanation style when uncertainty is high.

Lessons are stored in `data/evolution/lessons.jsonl`. They include the game, market, result, lesson type, summary, suggested adjustment, supporting numeric context, and diagnostic self-questions such as whether the model ignored bullpen fatigue or should have returned NO BET.

Symbolic updates are proposed rule, prompt, threshold, confidence, tool-order, explanation, data-quality, or weighting candidates. They are stored as pending candidates and are not production changes.

Backtesting protects the model by requiring before/after metrics before promotion. The promotion gate checks sample size, ROI or loss improvement, Brier score, log loss, calibration, NO BET quality, CLV, drawdown, safety-rule preservation, and high-confidence risk.

Prompt, rule, and weight versioning:

- Active prompt versions live in `data/evolution/prompt_versions.json`.
- Active rule version metadata lives in `data/evolution/approved_rules.json`.
- Active weight versions live in `data/evolution/weight_versions.json`.
- Candidate versions are appended instead of overwriting active versions.
- Rollback metadata is kept for approved versions.

Evolution storage:

```text
data/evolution/prediction_outcomes.csv
data/evolution/lessons.jsonl
data/evolution/rule_candidates.jsonl
data/evolution/approved_rules.json
data/evolution/rejected_rules.json
data/evolution/weight_versions.json
data/evolution/evolution_log.jsonl
data/evolution/trajectories.jsonl
data/evolution/language_losses.jsonl
data/evolution/language_gradients.jsonl
data/evolution/prompt_versions.json
data/evolution/tool_usage_reports.jsonl
data/evolution/symbolic_updates.jsonl
data/evolution/audit_reports.jsonl
```

Telegram command utama untuk evolution:

```text
/evolve  satu command full-otomatis: evaluasi, learn, propose, backtest (alias: /audit)
```

Kamu tidak perlu menjalankan command evolution dari terminal VPS. Bot Telegram menjalankan module Python yang sesuai di background, lalu mengirim hasilnya kembali ke chat.

Saat `/evolve` dijalankan, bagian audit-nya akan merangkum:

1. Weakest segments.
2. Root cause dari language loss.
3. Calibration bucket, misalnya apakah pick 60-65% terlalu percaya diri.
4. CLV report dari opening/pick odds vs closing odds jika data tersedia.
5. Reason quality, agar agent tahu faktor mana yang sering benar atau misleading.
6. Confidence cap candidates yang masih audit-only dan wajib backtest.

Candidate tidak otomatis mengubah production behavior. Perubahan prompt/rule/weight tetap harus melewati backtest dan promotion gate.

Audit layer:

- Membuat weakness ranking per segment seperti market, confidence, edge bucket, data quality, no-bet, dan CLV.
- Membuat calibration bucket berdasarkan predicted probability vs observed win rate.
- Membaca CLV jika closing line tersedia; jika belum tersedia, audit akan menandai sample CLV masih kosong.
- Mengukur reason quality dari faktor seperti starter, offense, bullpen, lineup, injury, market edge, record/H2H, weather, dan opener/bulk.
- Mengusulkan confidence cap candidate saat bucket/segment terlihat overconfident.
- Menghitung root cause paling sering dari language losses.
- Mengubah root cause menjadi rekomendasi praktis.
- Meranking rule/symbolic candidates agar kandidat paling berulang diuji dulu.
- Audit hanya diagnosis. Audit tidak mempromosikan candidate dan tidak mengubah production behavior.

To view the Evolution tab, run the dashboard and open `http://localhost:5173`, then select `Evolution`. The tab shows summary counts, recent trajectories, lessons, language losses, language gradients, symbolic candidates, approved changes, and risk warnings.

Rollback is supported through version metadata. A prompt rollback can be performed with `rollback_prompt_version()` in `src.evolution.prompt_versioning`; approved rule and weight records keep previous versions so a future operator can restore a known-good version deliberately.

## Python ML Prediction Engine

Selain bot Telegram, project ini punya engine Python lokal untuk eksperimen model MLB dari CSV.

Install dependency Python:

```bash
npm run setup:python
```

Jalankan sample prediction:

```bash
python3 -m src.predict --home "Los Angeles Dodgers" --away "New York Yankees"
```

Dengan odds market:

```bash
python3 -m src.predict --home "Los Angeles Dodgers" --away "New York Yankees" --home-odds -120
```

Dengan total runs / over-under:

```bash
python3 -m src.predict --home "Los Angeles Dodgers" --away "New York Yankees" --market-total 8.5 --over-odds -110 --under-odds -110
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
PYTHON_BIN=python3
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

Telegram interactive actions:

```text
/agenttools
/tools
/kb why does FIP matter more than ERA?
```

`/agenttools` membuka tombol:

- `Game Tools`: pilih game dari CSV/sample layer.
- `Moneyline`: output pick, probability, market ML, edge, dan no-bet flag.
- `Total`: output projected total, market total, over/under line, confidence, dan no-bet flag.
- `Context`: output park, weather, market total, dan run line.
- `Full`: ringkasan minimal moneyline + total + faktor utama.
- `Knowledge`: tombol wRC+, FIP, wind, bullpen, market total, value bet, betting markets, dan first 5.

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
LINE_MONITOR_INTERVAL_MINUTES=10
```

`ODDS_API_KEY` atau `THE_ODDS_API_KEY` juga mengaktifkan live line movement monitor. Setelah `/today`, `/deep`, atau auto-update mengirim slate hari ini, bot menyimpan odds pertama sebagai baseline di SQLite lalu mengecek ulang setiap `LINE_MONITOR_INTERVAL_MINUTES`. Telegram akan memberi alert jika moneyline bergerak 15+ cents atau total bergerak 0.5+ runs.

Notifikasi line movement bisa dimatikan per chat dari Telegram:

```text
/linealerts off
/linealerts on
/linealerts status
```

Alias yang sama juga tersedia lewat `/linemove off|on|status`.

### Moneyline Value Engine

Jika odds tersedia, alert Telegram sekarang menampilkan `Value Pick` dan `Bet Decision`. Value dihitung dari probabilitas model dikurangi implied probability market. Artinya tim dengan probabilitas menang lebih kecil tetap bisa menjadi value jika odds-nya terlalu murah menurut model.

Contoh: model memberi Team A 45%, tetapi odds +160 hanya mengimplikasikan sekitar 38.5%. Edge value sekitar +6.5%, sehingga bisa lebih bernilai daripada favorite 55% dengan odds yang sudah terlalu mahal.

`Bet Decision: NO BET` muncul saat edge value kecil, lineup belum confirmed, opener/bulk pitcher aktif, probable pitcher belum jelas, atau record/H2H lebih dominan daripada matchup hari ini. Ini sengaja konservatif agar bot tidak memaksa pick dari persen terbesar saja.

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

## Prediction Quality Control

Sebelum agent memberi final betting lean, project menjalankan quality-control layer:

- `src/data_freshness.py`: cek apakah data masih fresh, stale, atau missing.
- `src/quality_control.py`: cek kelengkapan input, hitung data quality score, downgrade confidence, dan putuskan `BET / LEAN / NO BET`.

Data yang dicek:

- Probable pitcher.
- Lineup confirmed/projected/missing.
- Weather fresh/stale/missing.
- Odds fresh/stale/missing.
- Bullpen usage.
- Park factor.
- Market total dan market odds.
- Injury/news context.
- Calibration support untuk High confidence.

Scoring quality:

```text
Probable pitchers confirmed: +20
Lineup confirmed: +15
Weather fresh: +10
Odds fresh: +15
Bullpen usage available: +15
Park factor available: +10
Market total available: +10
Injury/news context available: +5
```

No-bet filter aktif saat:

- Probable pitcher missing.
- Model edge di bawah 2%.
- Selisih projected total vs market total di bawah 0.4 run untuk totals.
- Data quality score di bawah 60.
- Market edge tidak tersedia.

Confidence otomatis diturunkan saat:

- Odds stale.
- Weather stale untuk outdoor stadium.
- Lineup belum confirmed.
- Probable pitcher masih projected.
- Data quality score belum cukup kuat.
- Calibration belum mendukung High confidence.

Output Telegram `/agenttools` dan command `/predict HOME | AWAY` sekarang menampilkan:

```text
Decision: BET / LEAN / NO BET
Quality: 82/100
No-bet: YES/NO
```

Prinsip penting: agent tidak boleh memberi `High` confidence jika lineup belum confirmed, probable pitcher missing/projected, odds stale, weather stale untuk outdoor stadium, atau calibration belum mendukung high confidence.

### Declarative moneyline rules (single source of truth)

Ambang batas, urutan, dan message untuk kedua moneyline decision engine tersimpan di satu katalog: `data/rules/moneyline_rules.json` (`version: "moneyline-rules-v1"`). Dua interpreter membaca file ini:

- `src/rule_engine.js` -> dipakai live JS engine (`src/mlb.js` `valueSafetyReasons` / `applyMoneylineValueMarket`).
- `src/rule_engine.py` -> dipakai offline Python engine (`src/quality_control.py` `apply_confidence_downgrade`).

Invariant yang WAJIB dijaga (di-enforce oleh schema test + parity test di kedua sisi):

1. Rule dievaluasi berdasarkan `order` menaik. `order` meniru urutan baris kode asli agar output reason/adjustment tetap byte-identical. `tier` (1/2/3) hanya metadata deskriptif dari taxonomy input-signal (Tier 1 pitcher/offense/bullpen/park/odds; Tier 2 weather/lineup/form; Tier 3 umpire/public/H2H) dan TIDAK memengaruhi urutan evaluasi.
2. Logika predikat hidup di handler per-bahasa (`JS_HANDLERS` / `PY_HANDLERS`); hanya threshold, message, order, scope, dan tier yang tinggal di JSON.
3. Setiap `handler` sebuah rule harus terdaftar di registry engine yang men-scope-nya, dan setiap handler terdaftar harus dirujuk oleh sebuah rule (bijection, dites dua arah).
4. Format angka tinggal di handler karena JS (`.toFixed`) dan Python (`:.0f`) berbeda.

Perubahan `id`/`engines`/`tier`/`order`/`action`/`message` harus menjaga kedua schema test (`tests/test_rule_schema.js`, `tests/test_rule_schema.py`) dan kedua parity suite (`tests/test_rule_engine_parity.js`, `tests/test_rule_engine_parity.py`) tetap hijau. Blok `_doc` di dalam JSON adalah salinan ringkas kontrak ini; jaga keduanya sinkron.

## Modular Agent Pipeline

Agent sekarang memakai pipeline berlapis supaya tidak bingung oleh terlalu banyak sinyal:

```text
Data Collection
  -> Feature Engineering
  -> Prediction
  -> Market Comparison
  -> Quality Control
  -> Explanation
```

Tanggung jawab tiap layer:

- `src/data_collection.py`: hanya ambil schedule, pitcher, team stats, bullpen, weather, park, lineup, odds, dan historical data.
- `src/feature_engineering_layer.py`: hanya ubah raw data menjadi fitur bersih seperti `pitcher_score`, `offense_score`, `bullpen_score`, adjustment park/weather/lineup, recent form, dan market implied probability.
- `src/prediction_layer.py`: hanya menghasilkan moneyline probability, expected runs, projected total, dan over/under probabilities.
- `src/market_comparison.py`: hanya menghitung edge, implied probability, dan line movement.
- `src/quality_control.py`: hanya mengecek missing/stale data, downgrade confidence, dan `NO BET`.
- `src/explanation_layer.py`: hanya menjelaskan hasil final dengan bahasa sederhana.
- `src/prediction_pipeline.py`: orkestrasi urutan layer di atas.

Signal priority:

- Tier 1: probable pitchers, team offense, bullpen usage, park factor, market odds.
- Tier 2: weather, confirmed lineup, platoon splits, recent form.
- Tier 3: umpire tendency, public betting percentage, news sentiment, H2H trends.

Aturan konservatif:

- Tier 1 punya pengaruh terbesar.
- Tier 2 hanya adjustment.
- Tier 3 hanya context.
- Recent form tidak boleh mendominasi model.
- Umpire tendency tidak boleh override pitcher/offense/bullpen.
- Jika Tier 1 penting hilang, confidence turun atau `NO BET`.
- Jika model edge kecil, return `NO BET`.
- Jika data quality rendah, return `NO BET`.
- LLM tidak boleh mengarang probabilitas. Semua angka berasal dari deterministic Python/JS model atau trained ML model.

## Backtesting, Evaluation, And Calibration

Project ini juga punya pipeline validasi model dari CSV lokal:

```bash
python3 -m src.backtest --season 2025 --market moneyline
python3 -m src.backtest --season 2025 --market totals
python3 -m src.backtest --start-date 2025-09-01 --end-date 2025-09-30 --market totals
python3 -m src.evaluate --report
```

Output backtest disimpan ke:

```text
data/predictions_log.csv
```

Kolom log:

- `game_id`, `date`, `home_team`, `away_team`
- `predicted_winner`, `home_win_probability`, `away_win_probability`
- `projected_total_runs`, `market_total`, `over_probability`, `under_probability`
- `model_edge`, `confidence`, `final_lean`
- `actual_home_score`, `actual_away_score`, `actual_total_runs`
- `result`, `profit_loss`, `closing_line`, `closing_line_value`

Metric evaluasi:

- Accuracy dan win rate.
- ROI per 1 unit stake.
- Average model edge.
- Average closing line value atau CLV.
- Brier score dan log loss.
- Calibration by probability bucket.
- Calibration by confidence bucket.
- Performance by market total range: `6.5 to 7.5`, `8.0 to 8.5`, `9.0 to 9.5`, `10.0+`.
- Performance by confidence: `low`, `medium`, `high`.

No-bet filter aktif saat:

- Model edge di bawah 2%.
- Selisih projected total vs market di bawah 0.4 run.
- Probable pitcher hilang.
- Lineup belum confirmed dan confidence low.
- Weather hilang untuk outdoor game.
- Odds stale atau market tidak tersedia.
- Bullpen data incomplete.
- Confidence di bawah threshold.

Catatan anti data leakage:

- Backtest hanya memakai fitur pre-game dari CSV/model input.
- Final score hanya dipakai setelah prediksi dibuat untuk menentukan hasil.
- Rolling stats historis harus digeser sebelum target game.

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

Test (JS + Python):

```bash
npm test              # syntax check + node --test tests/*.js + pytest
npm run test:js       # hanya JS tests
npm run test:py       # hanya Python tests
```

Catatan: ini bukan betting advice. MLB punya variance tinggi, dan probabilitas model bukan jaminan hasil.

## Command Telegram

Menu command Telegram sengaja dibuat pendek. Command utama yang muncul hanya:

```text
/picks
/today
/deep
/game Yankees
/ledger
/shadow
/auditcard
/ask best 5 top pick for today
/evolve
/linealerts off
/linealerts status
```

Ringkasan command utama:

- `/picks` — top pick model hari ini dengan confidence band, edge, dan risk warning (`/picks YYYY-MM-DD` untuk tanggal lain).
- `/ledger` — rekap bet nyata: open, record, units P/L, ROI.
- `/shadow` — paper ledger kandidat VALUE yang diblokir CLV gate.
- `/auditcard` — audit satu prediksi immutable: model, probabilitas raw vs calibrated vs market, kontribusi fitur, data quality, alasan keputusan, hasil + CLV.
- `/evolve` — satu command full-otomatis: evaluasi hasil final, belajar, propose, backtest (alias `/audit`).
- `/analyze` — analisa edge, risk, value, dan no-bet slate hari ini.

Command lama seperti `/predict`, `/memory`, `/postgame`, `/linecheck`, dan `/agenttools` masih ada sebagai hidden/backward-compatible command, tetapi tidak ditampilkan di menu utama agar Telegram tetap bersih.

Kamu juga bisa langsung bertanya tanpa slash:

```text
kenapa Dodgers dipilih?
upset risk terbesar hari ini?
bandingkan Yankees vs Rangers
```

Integrasi tanpa command baru:

- `/ask best 5 top pick for today` menampilkan tier `Strong Pick`, `Lean Only`, `Thin Lean`, atau `No Bet Risk`.
- `/today` tetap ringkas, tetapi akan memberi `Late Watch` jika ada risiko besar seperti opener/bulk atau probable pitcher TBD.
- `/deep` menampilkan `Late Watch` lebih lengkap: lineup belum confirmed, odds belum lengkap, market total belum tersedia, opener/bulk, atau pitcher TBD.
- `/evolve` menjadi pusat evaluasi: calibration, CLV, reason quality, confidence cap candidate, weakest segment, dan root cause.
- `/auditcard` menjadi pusat inspeksi per-prediksi: apa yang diketahui sistem saat prediksi dibuat dan apa hasilnya.

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
- Injury report dipakai sebagai availability risk, terutama hitter inti, starter, catcher, dan reliever leverage.
- Memory adalah sinyal kecil, bukan penentu utama.

ML reference layer yang ikut masuk ke Agent:

- Ensemble agreement dari beberapa sinyal, bukan satu angka saja.
- Pythagorean expectation untuk melihat regression risk.
- Log5 untuk prior matchup dari kekuatan dua tim.
- Recent window last 5-10 games dan last 3-5 starter starts.
- Anti data leakage: tidak memakai data yang belum tersedia sebelum game.
- Market-edge thinking jika odds/implied probability ditambahkan dari external agent.
- Score/run thinking sebagai pendukung full-game moneyline.

Referensi GitHub yang dipakai sebagai inspirasi metodologi:

- https://github.com/whrg/MLB_prediction
- https://github.com/andrew-cui-zz/mlb-game-prediction
- https://github.com/Forrest31/Baseball-Betting-Model
- https://github.com/kylejohnson363/Predicting-MLB-Games-with-Machine-Learning
- https://github.com/laplaces42/mlb_game_predictor

## YRFI/NRFI (removed)

First-inning-run (YRFI/NRFI) prediction was **removed**. Historical analysis found
no per-game edge (near-zero correlation with outcomes; overconfidence in high
bins). The market had already been advisory-only (`YRFI_ACTIVE` off by default).
The bot is **moneyline model-pick only**. Historical `yrfi_results` rows in SQLite
are retained but no longer written or graded.

## Post-game Memory

Saat game final:

1. Bot membaca hasil akhir.
2. Membandingkan pick agent vs winner aktual.
3. Menyimpan hasil ke `data/state.sqlite`.
4. Mengirim post-game recap ke Telegram.

Cek memory:

```text
/memory
```

Memory yang disimpan:

- Full-game (moneyline) accuracy.
- Accuracy per confidence bucket.
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
src/dashboard.js      Web dashboard lokal untuk monitoring model, QC, backtest, dan knowledge
src/mlb.js            Data MLB, baseline model, value engine, formatter alert
src/core/             Pure prediction core: prediction_core.js (heuristic_v1),
                      feature_vector.js, learned_v2_logistic.js, market_residual_v2.js,
                      model_registry.js (shadow orchestrator), model_ids.js
src/prediction_snapshot.js Immutable pre-game snapshot builder
src/prediction_replay.js   Replay prediksi dari snapshot (parity check)
src/prediction_audit.py    Backend Prediction Audit Card (normalized read-only audit)
src/auditCard.js      Telegram /auditcard (JS port dari audit reader)
src/lineMovement.js   Live odds line movement monitor dan Telegram alert
src/clv_gate.js       Rolling CLV gate untuk VALUE bets
src/llm.js            Analyst Agent local/external
src/storage.js        SQLite state + immutable history writer
src/storage/migrations/ Migrasi SQL berurutan (prediction_runs, model_predictions,
                      market_quote_pairs, shadow_ledger, append-only picks, folds)
src/telegram.js       Telegram Bot API wrapper
src/analystSkill.js   Analyst playbook prompt
src/rule_engine.js    Interpreter declarative moneyline rules (JS)
src/rule_engine.py    Interpreter declarative moneyline rules (Python)
src/eval/             Evaluasi kronologis: metrics, baselines, compare_models,
                      ablation, oof_calibration, recommend, generate_p7_reports
src/dataset/          Builder dataset per-game untuk trainer offline
src/features.py       Formula sabermetric Python
src/model.py          Baseline prediction dan optional sklearn models
src/totals.py         Total runs dan over/under probabilities
src/backtest.py       Backtest moneyline/totals dan tulis predictions log
src/evaluate.py       Evaluasi ROI, CLV, Brier, log loss, calibration
src/calibration.py    Confidence/probability calibration helpers
src/calibration.js    Kalibrasi live JS (per-market mapping + artifact hash)
src/dashboard_api.py  FastAPI backend dashboard (termasuk endpoint audit)
src/dashboard_service.py Business logic dashboard
dashboard-react/      Frontend React + Tailwind (termasuk tab Audit)
src/data_collection.py Raw data collection layer
src/feature_engineering_layer.py Clean model feature layer
src/prediction_layer.py Deterministic moneyline/totals prediction layer
src/market_comparison.py Edge and line movement layer
src/explanation_layer.py Simple final explanation layer
src/prediction_pipeline.py Orchestrates the modular agent pipeline
src/data_freshness.py Fresh/stale/missing checks untuk input prediction
src/quality_control.py No-bet filter, data quality score, confidence downgrade
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
src/evolution/        Evolution engine Python (lessons, gradients, candidates, promotion gate)
docs/analyst-playbook.md
docs/PREDICTION_AUDIT_CARD.md Cara inspeksi/reproduksi satu prediksi
data/knowledge/       Sabermetric, prediction, betting, dan over/under knowledge files
data/prediction_snapshots/ Immutable snapshot JSON per prediksi
data/rules/moneyline_rules.json Katalog declarative moneyline rules
data/predictions_log.csv Sample backtest prediction log
.env.example          Template konfigurasi
requirements.txt      Dependency Python opsional
tests/                Unit tests Python + JS (node --test)
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

- Dashboard shows login page — set `DASHBOARD_API_TOKEN` in `.env` and restart.

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
