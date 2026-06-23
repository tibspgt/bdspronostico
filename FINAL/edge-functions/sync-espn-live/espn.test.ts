import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { normalizeName, surnameMatch, resolveSquadName } from './espn.ts'

Deno.test('normalizeName strips accents, case, extra spaces', () => {
  assertEquals(normalizeName('  Kylian  MBAPPÉ '), 'kylian mbappe')
  assertEquals(normalizeName('Lautaro Martínez'), 'lautaro martinez')
})

Deno.test('surnameMatch compares last token', () => {
  assertEquals(surnameMatch('K. Mbappé', 'Kylian Mbappe'), true)
  assertEquals(surnameMatch('Messi', 'L. Messi'), true)
  assertEquals(surnameMatch('Lautaro Martinez', 'Julian Alvarez'), false)
})

Deno.test('resolveSquadName matches by surname, returns canonical roster name', () => {
  const roster = ['Kylian Mbappé', 'Antoine Griezmann', 'Aurélien Tchouaméni']
  assertEquals(resolveSquadName('K. Mbappé', roster), 'Kylian Mbappé')
  assertEquals(resolveSquadName('Griezmann', roster), 'Antoine Griezmann')
  assertEquals(resolveSquadName('Unknown Player', roster), null)
})
