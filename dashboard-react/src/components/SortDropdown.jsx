import { Select } from './ui/form.jsx';

export default function SortDropdown({ value, options, onChange }) {
  return (
    <Select value={value} onChange={(event) => onChange(event.target.value)} aria-label="Sort games">
      {options.map(([optionValue, label]) => <option key={optionValue} value={optionValue}>{label}</option>)}
    </Select>
  );
}
