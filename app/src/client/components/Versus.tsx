// Logos from Devicon 2.17.0 (MIT).
import postgresLogo from '../logos/postgres.svg';
import clickhouseLogo from '../logos/clickhouse.svg';

// The two engines side by side, top left. Screen readers hear "Postgres vs ClickHouse".
export function Versus() {
  return (
    <p className="versus">
      <span className="versus-side">
        <img src={postgresLogo} alt="" width={22} height={22} />
        <span className="versus-name">Postgres</span>
      </span>
      <span className="versus-rule" aria-hidden />
      <span className="visually-hidden"> vs </span>
      <span className="versus-side">
        <img className="versus-ch" src={clickhouseLogo} alt="" width={18} height={18} />
        <span className="versus-name">ClickHouse</span>
      </span>
    </p>
  );
}
