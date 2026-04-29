import { Slot } from '@radix-ui/react-slot';
import { cva } from 'class-variance-authority';
import { forwardRef } from 'react';
import { cn } from '../../lib/utils.js';

const buttonVariants = cva(
  'inline-flex min-h-10 items-center justify-center gap-2 rounded-md text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-blue-600 text-white hover:bg-blue-700',
        secondary: 'border border-line bg-white text-ink hover:bg-slate-50',
        ghost: 'text-slate-600 hover:bg-slate-100 hover:text-ink',
        danger: 'bg-rose-600 text-white hover:bg-rose-700',
      },
      size: {
        sm: 'h-9 px-3',
        md: 'h-10 px-4',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'md',
    },
  }
);

const Button = forwardRef(({ className, variant, size, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : 'button';
  return <Comp ref={ref} className={cn(buttonVariants({ variant, size, className }))} {...props} />;
});

Button.displayName = 'Button';

export { Button, buttonVariants };
