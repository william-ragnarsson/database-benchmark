import type { Route } from '../hooks';

const LINKS: { route: Route; label: string }[] = [
  { route: 'data', label: 'Database' },
  { route: 'run', label: 'Run' },
  { route: 'history', label: 'History' },
];

export function Nav({ route }: { route: Route }) {
  return (
    <nav className="nav" aria-label="Main">
      <a className="nav-brand" href="#/data" aria-label="pg vs ch: Postgres vs ClickHouse, home">
        pg<i>vs</i>ch
      </a>
      {LINKS.map((l) => (
        <a key={l.route} className="nav-link" href={`#/${l.route}`} aria-current={route === l.route ? 'page' : undefined}>
          {l.label}
        </a>
      ))}
    </nav>
  );
}
