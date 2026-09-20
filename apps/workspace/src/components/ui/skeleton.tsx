import { cn } from "cn"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "relative overflow-hidden rounded-md bg-muted-foreground/10",
        "before:pointer-events-none before:absolute before:inset-y-0 before:left-0 before:w-1/2",
        "before:-translate-x-full before:will-change-transform",
        "before:bg-linear-to-r before:from-transparent before:via-background/60 before:to-transparent",
        "before:animate-[skeleton-shimmer_1.15s_cubic-bezier(0.4,0,0.2,1)_infinite]",
        "motion-reduce:before:animate-none",
        className
      )}
      {...props}
    />
  )
}

export { Skeleton }
