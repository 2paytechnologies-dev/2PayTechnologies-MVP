import * as React from "react";
import { cn } from "@/lib/utils";

const variants = {
  default: "bg-brand text-slate-950 hover:bg-brand/90",
  outline: "border border-slate-700 bg-transparent text-slate-100 hover:bg-slate-800",
  ghost: "text-slate-300 hover:bg-slate-800",
  destructive: "text-rose-300 hover:bg-rose-500/10",
} as const;

const sizes = {
  default: "h-10 px-4 text-sm",
  sm: "h-8 px-3 text-xs",
  icon: "h-8 w-8",
} as const;

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant = "default", size = "default", type = "button", ...props }, ref) => (
  <button
    ref={ref}
    type={type}
    className={cn(
      "inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:pointer-events-none disabled:opacity-50",
      variants[variant],
      sizes[size],
      className,
    )}
    {...props}
  />
));
Button.displayName = "Button";
