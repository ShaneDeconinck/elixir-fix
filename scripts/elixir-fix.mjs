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
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))

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
    const direct = ['dependencies', 'devDependencies', 'optionalDependencies']
      .some((sleutel) => manifest[sleutel]?.[item.pkg])

    // Meerdere majors van hetzelfde pakket: dan zet een override ze allemaal op één versie,
    // en de andere lijn krijgt een stille downgrade. Zo brak brace-expansion de build van de
    // frituur: 5.x werd teruggezet naar 2.x, en die consumenten verwachten een export die
    // daar niet bestaat. Dit is werk voor een mens, geen boom om door te drukken.
    const majors = new Set(versiesVan(item.pkg).map((v) => v.split('.')[0]))
    if (!direct && majors.size > 1) {
      mislukt.push({
        pkg: item.pkg,
        why: `de boom draagt ${[...majors].join(' en ')}.x van dit pakket; een override zou ze allemaal verzetten`,
      })
      continue
    }

    try {
      if (direct) {
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
// update niet, hoe vrolijk npm ook deed.
const blijft = []
for (const item of gedaan) {
  const lock = existsSync(item.lock) ? readFileSync(item.lock, 'utf8') : ''
  const versies = [...lock.matchAll(new RegExp(`"node_modules/${item.pkg.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}"[^}]*?"version": "([^"]+)"`, 'g'))]
    .map((m) => m[1])
  if (versies.length && !versies.includes(item.to)) {
    blijft.push({ pkg: item.pkg, why: `lockfile draagt ${versies.join(', ')} en niet ${item.to}` })
  }
}

const uitslag = {
  applied: gedaan.filter((g) => !blijft.some((b) => b.pkg === g.pkg)),
  failed: mislukt,
  unproven: blijft,
}

console.log(JSON.stringify(uitslag, null, 2))
process.env.GITHUB_OUTPUT &&
  execFileSync('bash', ['-c', `printf '%s\\n' "uitslag<<EOF" ${JSON.stringify(JSON.stringify(uitslag))} "EOF" >> "$GITHUB_OUTPUT"`])
