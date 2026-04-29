import { RotateCcw, Save } from 'lucide-react';
import { Button } from './ui/button.jsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card.jsx';
import { Field, Input, Switch } from './ui/form.jsx';

const numericFields = [
  ['minimum_moneyline_edge', 'Minimum moneyline edge', 'Minimum edge before highlighting a moneyline.', 0.01],
  ['minimum_total_edge', 'Minimum total edge', 'Minimum edge before highlighting an over/under.', 0.01],
  ['minimum_projected_total_difference', 'Minimum projected total difference', 'NO BET if model vs market total is too close.', 0.1],
  ['minimum_data_quality_score', 'Minimum data quality score', 'NO BET below this quality score.', 1],
  ['odds_stale_minutes', 'Odds stale threshold minutes', 'Warn when odds are older than this.', 1],
  ['weather_stale_minutes', 'Weather stale threshold minutes', 'Warn when outdoor weather is older than this.', 1],
  ['auto_refresh_minutes', 'Auto-refresh interval minutes', 'Keep between 5 and 15 minutes for a conservative refresh cadence.', 1],
  ['low_confidence_threshold', 'Low confidence threshold', 'Probability boundary for low confidence.', 0.01],
  ['medium_confidence_threshold', 'Medium confidence threshold', 'Probability boundary for medium confidence.', 0.01],
  ['high_confidence_threshold', 'High confidence threshold', 'Probability boundary for high confidence.', 0.01],
];

const toggles = [
  ['enable_weather_adjustment', 'Weather adjustment'],
  ['enable_umpire_adjustment', 'Umpire adjustment'],
  ['enable_market_movement_adjustment', 'Market movement adjustment'],
];

const defaults = {
  minimum_moneyline_edge: 0.02,
  minimum_total_edge: 0.02,
  minimum_projected_total_difference: 0.4,
  minimum_data_quality_score: 60,
  odds_stale_minutes: 15,
  weather_stale_minutes: 60,
  auto_refresh_minutes: 10,
  low_confidence_threshold: 0.53,
  medium_confidence_threshold: 0.57,
  high_confidence_threshold: 0.62,
  enable_weather_adjustment: true,
  enable_umpire_adjustment: false,
  enable_market_movement_adjustment: true,
};

const ranges = {
  minimum_data_quality_score: { min: 0, max: 100, step: 1 },
  auto_refresh_minutes: { min: 5, max: 15, step: 1 },
};

function NumberSetting({ field, settings, onChange }) {
  const [key, label, helper, step] = field;
  const range = ranges[key];
  return (
    <Field label={label} helper={helper}>
      <Input type="number" step={step} value={settings[key]} onChange={(event) => onChange({ ...settings, [key]: Number(event.target.value) })} />
      {range ? (
        <input
          type="range"
          min={range.min}
          max={range.max}
          step={range.step}
          value={settings[key]}
          className="w-full accent-blue-600"
          onChange={(event) => onChange({ ...settings, [key]: Number(event.target.value) })}
        />
      ) : null}
    </Field>
  );
}

export default function SettingsPanel({ settings, onChange, onSave, saving }) {
  const safeSettings = { ...defaults, ...settings };
  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle>Threshold Settings</CardTitle>
          <CardDescription>These values control conservative decisions, stale-data warnings, and confidence caps.</CardDescription>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" type="button" onClick={() => onChange(defaults)}>
            <RotateCcw size={16} />
            Reset
          </Button>
          <Button onClick={onSave} type="button">
            <Save size={16} />
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <section>
          <h3 className="mb-3 text-sm font-bold text-ink">Decision Thresholds</h3>
          <div className="grid gap-4 md:grid-cols-2">
            {numericFields.slice(0, 4).map(([key, label, helper, step]) => (
              <NumberSetting key={key} field={[key, label, helper, step]} settings={safeSettings} onChange={onChange} />
            ))}
          </div>
        </section>
        <section>
          <h3 className="mb-3 text-sm font-bold text-ink">Freshness and Refresh</h3>
          <div className="grid gap-4 md:grid-cols-3">
            {numericFields.slice(4, 7).map(([key, label, helper, step]) => (
              <NumberSetting key={key} field={[key, label, helper, step]} settings={safeSettings} onChange={onChange} />
            ))}
          </div>
        </section>
        <section>
          <h3 className="mb-3 text-sm font-bold text-ink">Confidence Thresholds</h3>
          <div className="grid gap-4 md:grid-cols-3">
            {numericFields.slice(7).map(([key, label, helper, step]) => (
              <NumberSetting key={key} field={[key, label, helper, step]} settings={safeSettings} onChange={onChange} />
            ))}
          </div>
        </section>
        <section>
          <h3 className="mb-3 text-sm font-bold text-ink">Model Adjustments</h3>
          <div className="grid gap-3 md:grid-cols-3">
            {toggles.map(([key, label]) => (
              <Switch
                key={key}
                label={label}
                helper={key === 'enable_umpire_adjustment' ? 'Optional context only.' : 'Used as a model adjustment when data exists.'}
                checked={Boolean(safeSettings[key])}
                onChange={(value) => onChange({ ...safeSettings, [key]: value })}
              />
            ))}
          </div>
        </section>
      </CardContent>
    </Card>
  );
}
