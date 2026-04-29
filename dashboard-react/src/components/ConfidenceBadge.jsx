import PredictionBadge from './PredictionBadge.jsx';

export default function ConfidenceBadge({ value }) {
  const label = value ? `${value} Confidence` : 'Low Confidence';
  return <PredictionBadge>{label}</PredictionBadge>;
}
