import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';

export function NavigationSectionHeader({
  label,
  controls,
  expanded,
  onToggle,
  children,
}: {
  label: string;
  controls: string;
  expanded: boolean;
  onToggle: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="section-label navigation-section-heading">
      <button
        type="button"
        className="section-disclosure"
        aria-expanded={expanded}
        aria-controls={controls}
        onClick={onToggle}
      >
        <ChevronRight size={14} aria-hidden="true" />
        {label}
      </button>
      {children && <div className="channel-management-actions">{children}</div>}
    </div>
  );
}
