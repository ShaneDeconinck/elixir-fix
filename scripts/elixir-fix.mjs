// De handen van elixir-fix, hier in plaats van op onze eigen machine.
//
// Elixir beslist WAT er moet gebeuren: welke pakketten, naar welke versie, in welke
// lockfile. Dat oordeel is deterministisch en hoort bij de meting. Dit script doet alleen
// het werk, en het draait waar het hoort: in een wegwerp-VM van de repo zelf, met een token
// die GitHub uitdeelt voor deze ene run.
//
// Het verschil is niet cosmetisch. Vroeger draaide `npm install` op de machine met alle
// tokens van de vloot erop, dus één postinstall-script in één afhankelijkheid van één
// klantproject las ze allemaal. Hier bestaat die map niet.

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

const plan = JSON.parse(process.env.PLAN || '[]')
if (!plan.length) {
  console.log('geen plan meegegeven, niets te doen')
  process.exit(0)
}

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const gedaan = []
const mislukt = []

// Per lockfile, niet per project: een repo met workspaces heeft er meerdere, en een
// override in de root doet niets voor een boom die een niveau lager hangt.
const perLock = {}
for (const item of plan) (perLock[item.lock] ||= []).push(item)

for (const [lock, items] of Object.entries(perLock)) {
  const dir = dirname(lock) === '.' ? process.cwd() : join(process.cwd(), dirname(lock))
  const composer = lock.endsWith('composer.lock')
  const manifestNaam = composer ? 'composer.json' : 'package.json'
  const manifest = JSON.parse(readFileSync(join(dir, manifestNaam), 'utf8'))

  // Welke versies van dit pakket staan er in de boom? Een override geldt voor ALLE
  // kopieën, dus dat is de vraag die vooraf gesteld hoort te worden.
  const lockText = readFileSync(join(process.cwd(), lock), 'utf8')
  const versiesVan = (pkg) => [...new Set([...lockText.matchAll(
    new RegExp(`"node_modules/(?:[^"]*/)?${pkg.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}"[^}]*?"version": "([^"]+)"`, 'g'),
  )].map((m) => m[1]))]

  for (const item of items) {
    // Direct installeren, transitief overriden. Een transitief pakket als directe
    // afhankelijkheid bijzetten liegt over wat het project gebruikt, lang nadat het lek
    // vergeten is.
    const velden = composer
      ? ['require', 'require-dev']
      : ['dependencies', 'devDependencies', 'optionalDependencies']
    const direct = velden.some((sleutel) => manifest[sleutel]?.[item.pkg])

    // Meerdere majors van hetzelfde pakket: dan zet een override ze allemaal op één versie,
    // en de andere lijn krijgt een stille downgrade. Zo brak brace-expansion de build van de
    // frituur: 5.x werd teruggezet naar 2.x, en die consumenten verwachten een export die
    // daar niet bestaat. Dit is werk voor een mens, geen boom om door te drukken.
    const majors = new Set(versiesVan(item.pkg).map((v) => v.split('.')[0]))
    if (!composer && !direct && majors.size > 1) {
      mislukt.push({
        pkg: item.pkg,
        why: `de boom draagt ${[...majors].join(' en ')}.x van dit pakket; een override zou ze allemaal verzetten`,
      })
      continue
    }

    try {
      if (composer) {
        // -W is geen doordrukken maar een ruimere zoekruimte: zonder weigert composer met
        // "fixed to X by a partial update". Composer kent geen overrides, dus een
        // transitief pakket wordt bijgewerkt en niet gepind.
        run('composer', direct
          ? ['require', '-W', '--no-interaction', `${item.pkg}:^${item.to}`]
          : ['update', '-W', '--no-interaction', item.pkg], dir)
      } else if (direct) {
        run('npm', ['install', '--no-audit', '--no-fund', `${item.pkg}@${item.to}`], dir)
      } else {
        const pkgPath = join(dir, 'package.json')
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
        pkg.overrides = { ...(pkg.overrides || {}), [item.pkg]: item.to }
        run('node', ['-e', `require('fs').writeFileSync(${JSON.stringify(pkgPath)}, ${JSON.stringify(JSON.stringify(pkg, null, 2) + '\n')})`], dir)
        run('npm', ['install', '--no-audit', '--no-fund'], dir)
      }
      gedaan.push({ ...item, direct })
    } catch (e) {
      // De reden meegeven, want "mislukt" is geen antwoord.
      const uit = (e.stderr || e.stdout || String(e)).split('\n').find((r) => /error|ERR!/i.test(r))
      mislukt.push({ pkg: item.pkg, why: (uit || String(e)).slice(0, 200) })
    }
  }
}

// Bewijzen, niet beweren: de lockfile teruglezen. Staat de oude versie er nog, dan telt de
// update niet, hoe vrolijk het commando ook deed.
const blijft = []
for (const item of gedaan) {
  if (!existsSync(item.lock)) continue
  const lock = readFileSync(item.lock, 'utf8')
  const veilig = item.pkg.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')

  const versies = item.lock.endsWith('composer.lock')
    ? [...JSON.parse(lock).packages ?? [], ...JSON.parse(lock)['packages-dev'] ?? []]
        .filter((p) => p.name === item.pkg)
        // composer schrijft v7.29.0 waar het advies 7.29.0 zegt.
        .map((p) => String(p.version).replace(/^v/, ''))
    : [...lock.matchAll(new RegExp(`"node_modules/(?:[^"]*/)?${veilig}"[^}]*?"version": "([^"]+)"`, 'g'))]
        .map((m) => m[1])

  // Bij composer telt "minstens zo nieuw": require ^7.29 mag 7.29.4 opleveren, en dat is
  // geen mislukking maar precies de bedoeling van een caret.
  const goed = item.lock.endsWith('composer.lock')
    ? versies.every((v) => vergelijk(v, item.to) >= 0)
    : versies.includes(item.to)

  if (versies.length && !goed) {
    blijft.push({ pkg: item.pkg, why: `lockfile draagt ${versies.join(', ')} en niet ${item.to}` })
  }
}

/** Versies vergelijken zonder afhankelijkheid: -1, 0 of 1. */
function vergelijk(a, b) {
  const stukken = (v) => String(v).split('.').map((n) => parseInt(n, 10) || 0)
  const [x, y] = [stukken(a), stukken(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1
  }

  return 0
}

const uitslag = {
  applied: gedaan.filter((g) => !blijft.some((b) => b.pkg === g.pkg)),
  failed: mislukt,
  unproven: blijft,
}

console.log(JSON.stringify(uitslag, null, 2))
process.env.GITHUB_OUTPUT &&
  execFileSync('bash', ['-c', `printf '%s\\n' "uitslag<<EOF" ${JSON.stringify(JSON.stringify(uitslag))} "EOF" >> "$GITHUB_OUTPUT"`])
