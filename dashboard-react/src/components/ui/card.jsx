import { cn } from '../../lib/utils.js';

export function Card({ className = '', ...props }) {
  return <section className={cn('rounded-lg border border-line bg-white shadow-sm', className)} {...props} />;
}

export function CardHeader({ className = '', ...props }) {
  return <div className={cn('border-b border-line px-5 py-4', className)} {...props} />;
}

export function CardTitle({ className = '', ...props }) {
  return <h3 className={cn('text-base font-bold text-ink', className)} {...props} />;
}

export function CardDescription({ className = '', ...props }) {
  return <p className={cn('mt-1 text-sm text-slate-500', className)} {...props} />;
}

export function CardContent({ className = '', ...props }) {
  return <div className={cn('p-5', className)} {...props} />;
}
