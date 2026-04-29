import PredictionBadge from './PredictionBadge.jsx';

export default function DataFreshnessBadge({ value }) {
  return <PredictionBadge>{value || 'Waiting'}</PredictionBadge>;
}
