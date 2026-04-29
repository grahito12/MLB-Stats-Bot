import { Download, RefreshCw } from 'lucide-react';
import { Button } from './ui/button.jsx';
import { Card, CardContent } from './ui/card.jsx';
import { Input, Select } from './ui/form.jsx';
import SortDropdown from './SortDropdown.jsx';

export default function FilterToolbar({
  filters,
  activeFilter,
  onFilterChange,
  sort,
  sorts,
  onSortChange,
  source,
  onSourceChange,
  date,
  onDateChange,
  loading,
  onRefresh,
  exportHref,
}) {
  return (
    <Card className="sticky top-[136px] z-10 shadow-sm lg:top-[104px]">
      <CardContent className="p-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex flex-wrap gap-2">
            {filters.map(([value, label]) => (
              <Button
                key={value}
                variant={activeFilter === value ? 'default' : 'secondary'}
                size="sm"
                onClick={() => onFilterChange(value)}
                type="button"
              >
                {label}
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <Input type="date" value={date} onChange={(event) => onDateChange(event.target.value)} />
            <Select value={source} onChange={(event) => onSourceChange(event.target.value)}>
              <option value="live">Live</option>
              <option value="sample">Sample</option>
              <option value="mock">Mock</option>
            </Select>
            <SortDropdown value={sort} options={sorts} onChange={onSortChange} />
            <Button onClick={onRefresh} type="button">
              <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
              Refresh
            </Button>
            <Button asChild variant="secondary">
              <a href={exportHref}>
                <Download size={16} />
                CSV
              </a>
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
