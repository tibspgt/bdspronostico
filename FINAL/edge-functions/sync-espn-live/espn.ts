// Fonctions pures pour la synchro ESPN. Aucune dépendance externe :
// testable avec `deno test`, importable par index.ts.

export function normalizeName(s: string): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // retire les accents
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function lastToken(s: string): string {
  const parts = normalizeName(s).split(' ').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : ''
}

export function surnameMatch(a: string, b: string): boolean {
  const la = lastToken(a), lb = lastToken(b)
  return la !== '' && la === lb
}

export function resolveSquadName(espnName: string, roster: string[]): string | null {
  const target = normalizeName(espnName)
  if (!target) return null
  // 1) égalité exacte normalisée
  for (const r of roster) if (normalizeName(r) === target) return r
  // 2) même nom de famille
  for (const r of roster) if (surnameMatch(espnName, r)) return r
  // 3) inclusion dans un sens ou l'autre
  for (const r of roster) {
    const nr = normalizeName(r)
    if (nr.includes(target) || target.includes(nr)) return r
  }
  return null
}
