import { Link } from 'react-router-dom';
import { ArrowRight } from '../icons';

export default function StubPage({ title, sub }: { title: string; sub: string }) {
  return (
    <main className="container stub">
      <div className="stub__card card">
        <span className="stub__tag">Coming next</span>
        <h1 className="display stub__title">{title}</h1>
        <p>{sub}</p>
        <Link className="btn btn-ghost" to="/">Back to live <ArrowRight width={16} height={16} /></Link>
      </div>
    </main>
  );
}
