import { Link } from 'react-router-dom';
import type { ComponentType, SVGProps } from 'react';

export default function EmptyState({
  icon: Icon,
  title,
  sub,
  ctaText,
  ctaTo,
}: {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  title: string;
  sub: string;
  ctaText?: string;
  ctaTo?: string;
}) {
  return (
    <div className="empty card">
      <span className="empty__ic"><Icon width={26} height={26} /></span>
      <h3>{title}</h3>
      <p className="muted">{sub}</p>
      {ctaText && ctaTo && <Link className="btn btn-primary" to={ctaTo}>{ctaText}</Link>}
    </div>
  );
}
