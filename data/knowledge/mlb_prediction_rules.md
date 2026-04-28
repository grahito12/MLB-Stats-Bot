# MLB Prediction Rules

## Moneyline Framework
Start with Pythagorean win percentage and Log5 as the neutral team-strength prior. Add starting pitcher quality, bullpen quality and fatigue, team offense, defense, home/away split, recent form, injuries, confirmed lineup, and market odds.

## Starting Pitcher Quality
Prefer process indicators over only ERA. FIP, xFIP, SIERA, K-BB%, WHIP, HR/9, xwOBA allowed, hard-hit allowed, barrel allowed, pitch count, rest days, and recent three-start form are useful for projecting current run prevention.

## Team Offense
Use wRC+, wOBA, xwOBA, OPS, ISO, barrel rate, hard-hit rate, strikeout rate, walk rate, runs per game, and splits versus pitcher handedness. wRC+ is especially useful because it is park and league adjusted.

## Bullpen
Bullpen fatigue matters because late innings decide many moneyline outcomes and add volatility to totals. Track bullpen innings last three days, relievers used yesterday, closer availability, high-leverage availability, and back-to-back usage.

## Recent Form
Recent form is useful but noisy. Use last 5 to 10 games for runs scored, runs allowed, OPS, and run differential, but do not let it override stronger season-long indicators unless multiple signals agree.

## Avoid Data Leakage
Historical backtests must shift rolling features before the target game. Same-day final scores, closing stats, post-game injuries, or future games must not enter pre-game features.

## No-Bet Discipline
If model edge is small, confidence is low, lineups are missing, or market has already moved against the number, the correct output can be no bet. A favorite can be a bad value if the market implied probability is higher than the model probability.

