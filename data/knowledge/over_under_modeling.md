# Over Under Modeling

## Total Runs Projection
Projected total runs start from league average total runs, then adjust for team offense, starting pitcher run prevention, bullpen quality and fatigue, park factor, weather, lineup, recent form, umpire tendency, and market information.

## Weather
Hot weather can increase carry. Cold weather can suppress carry. Wind blowing out increases home run and extra-base-hit risk, which raises over probability. Wind blowing in suppresses carry and can support under probability. Closed roofs reduce weather impact.

## Park Factor
Ballparks change run scoring. Coors Field is a classic high-run environment, while larger or marine-layer parks can suppress power. Park factor should be combined with hitter handedness and home-run factor when available.

## Bullpen Fatigue
Tired bullpens can turn close projections into late runs. Heavy innings over the last three days, many relievers used yesterday, unavailable closers, and back-to-back leverage arms increase total-runs risk.

## Starting Pitcher Run Prevention
FIP, xFIP, K-BB%, WHIP, HR/9, xwOBA allowed, barrel allowed, pitch count, and rest days help estimate whether a starter is likely to suppress or allow runs today.

## First Five Innings Indicators
Best first 5 indicators are starting pitcher quality, early-game offense splits, top-of-order strength, handedness matchups, weather, park factor, and lineup confirmation. Bullpen matters less for first 5 than full game.

## Poisson and Overdispersion
Poisson probabilities convert expected total runs into chances of clearing a half-run line. Baseball run scoring is overdispersed, so a negative binomial style adjustment can better reflect blow-up games.

