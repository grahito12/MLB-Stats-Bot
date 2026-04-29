import { cva } from 'class-variance-authority';
import { cn } from '../../lib/utils.js';

const badgeVariants = cva(
  'inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1',
  {
    variants: {
      variant: {
        default: 'bg-blue-50 text-blue-700 ring-blue-200',
        success: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
        warning: 'bg-amber-50 text-amber-700 ring-amber-200',
        danger: 'bg-rose-50 text-rose-700 ring-rose-200',
        neutral: 'bg-slate-100 text-slate-600 ring-slate-200',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

export function Badge({ className, variant, ...props }) {
  return <span className={cn(badgeVariants({ variant, className }))} {...props} />;
}

export { badgeVariants };
