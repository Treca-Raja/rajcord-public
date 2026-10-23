import type { ReactNode } from 'react';
export function Avatar({
  children,
  tone = 'green',
}: {
  children: ReactNode;
  tone?: 'green' | 'purple' | 'orange';
}) {
  return <span className={'avatar avatar-' + tone}>{children}</span>;
}
export function Badge({ children }: { children: ReactNode }) {
  return <span className="badge">{children}</span>;
}
