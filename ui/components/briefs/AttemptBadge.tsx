import { Badge } from "@/components/ui/badge";

interface AttemptBadgeProps {
  attemptNumber: number;
  maxAttempts: number;
}

export function AttemptBadge({ attemptNumber, maxAttempts }: AttemptBadgeProps) {
  if (attemptNumber <= 1) return null;
  return (
    <Badge variant="secondary" className="font-mono text-xs">
      attempt {attemptNumber} of {maxAttempts}
    </Badge>
  );
}
