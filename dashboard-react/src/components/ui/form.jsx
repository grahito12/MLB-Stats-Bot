import { cn } from '../../lib/utils.js';

export function Input({ className = '', ...props }) {
  return (
    <input
      className={cn(
        'h-10 rounded-md border border-line bg-white px-3 text-sm text-ink outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100',
        className
      )}
      {...props}
    />
  );
}

export function Select({ className = '', children, ...props }) {
  return (
    <select
      className={cn(
        'h-10 rounded-md border border-line bg-white px-3 text-sm text-ink outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100',
        className
      )}
      {...props}
    >
      {children}
    </select>
  );
}

export function Field({ label, helper, children, className = '' }) {
  return (
    <label className={cn('grid gap-1.5 text-sm font-semibold text-ink', className)}>
      {label}
      {children}
      {helper ? <span className="text-xs font-normal text-slate-500">{helper}</span> : null}
    </label>
  );
}

export function Switch({ checked, onChange, label, helper }) {
  return (
    <label className="flex items-center justify-between gap-4 rounded-lg border border-line bg-white px-4 py-3">
      <span>
        <span className="block text-sm font-semibold text-ink">{label}</span>
        {helper ? <span className="mt-1 block text-xs text-slate-500">{helper}</span> : null}
      </span>
      <input
        aria-label={label}
        type="checkbox"
        className="h-5 w-5 accent-blue-600"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

export function Progress({ value = 0, className = '' }) {
  const width = Math.max(0, Math.min(100, Number(value) || 0));
  const color = width >= 85 ? 'bg-emerald-500' : width >= 60 ? 'bg-amber-500' : 'bg-rose-500';
  return (
    <div className={cn('h-2 overflow-hidden rounded-full bg-slate-100', className)}>
      <div className={cn('h-full rounded-full transition-all', color)} style={{ width: `${width}%` }} />
    </div>
  );
}
