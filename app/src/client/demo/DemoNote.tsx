import indexJson from './recordings/index.json';

const REPO = 'https://github.com/william-ragnarsson/database-benchmark';

// The demo build's line under the header: the numbers are real, but recorded, not live.
export function DemoNote() {
  const day = new Date(indexJson.recordedAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  return (
    <aside className="demo-note" aria-label="About this demo">
      <p>
        <b>This is a demo.</b> The timings are real, recorded once for every query and size on {day} on one computer ({indexJson.machine}),
        and replayed here. To run the queries yourself, <a href={REPO}>clone the repo</a> and start it
        with <code>docker compose up</code>.
      </p>
    </aside>
  );
}
