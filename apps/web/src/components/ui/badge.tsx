import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md px-2 py-0.5 text-[0.72rem] font-semibold tracking-wide",
  {
    variants: {
      variant: {
        default: "bg-mint/15 text-mint",
        warn: "bg-amber/15 text-amber",
        danger: "bg-rose/15 text-rose",
        ok: "bg-emerald/15 text-emerald",
        muted: "bg-white/8 text-fog",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export function Badge({
  className,
  variant,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
