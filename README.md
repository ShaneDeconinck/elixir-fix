# elixir-fix

Beveiligingsupdates uitvoeren **in de repo die ze aangaan**, niet op de machine die de sleutels bewaart.

## Waarom

Een agent die kwetsbare pakketten bijwerkt, draait `npm install` op afhankelijkheden die
iemand anders schreef. Doet hij dat op de machine waar de tokens van een hele vloot staan,
dan leest één `postinstall`-script ze allemaal. Dat is geen theoretisch scenario: het is de
gewone manier waarop supply-chain-aanvallen werken.

Hier bestaat die map niet. De runner is een wegwerp-VM van dit project, de enige sleutel is
de token die GitHub voor deze ene run uitdeelt, en na afloop is alles weg.

## Rolverdeling

| | wie | waarom |
|---|---|---|
| het plan: welk pakket, naar welke versie | Elixir | dat is een oordeel, en oordelen horen bij de meting |
| installeren, testen, bouwen, teruglezen | deze workflow | daar bestaat de geheimenmap niet |
| het voorstel openen | Elixir | een pull request is een bewering, en die hoort bij wie ze kan verantwoorden |
| bevestigen of weerleggen | de volgende meting | de rechter is nooit de hand |

De workflow krijgt daarom alleen `contents: write`. Voorstellen mag ze niet, en dat is
opzet: bij GitHub is "mag pull requests maken" dezelfde schakelaar als "mag ze goedkeuren",
en een pull request die met de `GITHUB_TOKEN` geopend wordt zet geen checks in gang.

## Aansluiten

Zet dit in `.github/workflows/elixir-fix.yml` van je project:

```yaml
name: Elixir fix

on:
  workflow_dispatch:
    inputs:
      plan:
        required: true
        type: string

# Nodig: een aangeroepen workflow kan niet meer rechten krijgen dan de aanroeper heeft, en
# de meeste repo's staan standaard op read. Zonder deze regel eindigt de run als
# startup_failure: geen job, geen log, en een melding die alleen zegt "No jobs were run".
permissions:
  contents: write

jobs:
  fix:
    uses: ShaneDeconinck/elixir-fix/.github/workflows/fix.yml@v1
    with:
      plan: ${{ inputs.plan }}
```

Draait je project anders, dan zeg je dat erbij:

```yaml
    with:
      plan: ${{ inputs.plan }}
      node-version: '22'
      install: npm ci
      test: npm run test:unit
      build: ''          # leeg = geen build
      env: |             # publieke configuratie die de build nodig heeft
        PUBLIC_API_URL=https://api.example.com
```

Een PHP-project zegt het zo:

```yaml
    with:
      plan: ${{ inputs.plan }}
      php-version: '8.4'
      install: composer install --no-interaction --no-progress && npm ci
      prepare: |                  # wat er moet gebeuren voor de tests kunnen draaien
        cp env.example .env
        php artisan key:generate
      test: php artisan test
      build: npm run prod
```

Composer kent geen overrides: een transitief pakket wordt bijgewerkt met `update -W`, niet
gepind. En het teruglezen telt daar "minstens zo nieuw", want `require ^7.29` mag 7.29.4
opleveren; dat is geen mislukking maar precies wat een caret betekent.

Testen tegen een echte databank:

```yaml
    with:
      plan: ${{ inputs.plan }}
      php-version: '8.4'
      mysql: forge_test
      schema: database/schema/mysql-schema.sql
      env: |
        DB_HOST=127.0.0.1
        DB_DATABASE=forge_test
        DB_USERNAME=root
        DB_PASSWORD=root
```

Een aangeroepen workflow kan geen `services:` van de aanroeper krijgen, dus start hij de
databank zelf in docker en wacht tot ze antwoordt.

`env` is voor publieke configuratie, niet voor geheimen: wat daar staat komt uit het
workflow-bestand van je project en is dus voor iedereen leesbaar. Een echte sleutel hoort in
de secrets van de repo, en die heeft deze workflow niet nodig.

## De poorten

Elke stap is er een, en ze staan in deze volgorde omdat elke volgende duurder is:

1. **nulmeting** — staan de tests al rood, dan is er geen rechter en gebeurt er niets
2. **bijwerken** — direct installeren, transitief overriden
3. **tests opnieuw** — rood betekent: niets voorstellen
4. **bouwen** — een versiesprong breekt zelden een unit test en vaak een import
5. **teruglezen** — staat de nieuwe versie echt in de lockfile, of zei npm alleen ja?
6. **pas dan** een tak omhoog

Wat de workflow weigert, zegt ze erbij. Een override geldt bijvoorbeeld voor álle kopieën
van een pakket in de boom; draagt de lockfile er twee majors van, dan gebeurt er niets en
staat de reden in de uitslag.

## Uitslag

Als artifact `elixir-fix` met één `uitslag.json`:

```json
{
  "applied": [{"pkg": "tar", "to": "7.5.21", "lock": "package-lock.json", "direct": false}],
  "failed": [{"pkg": "brace-expansion", "why": "de boom draagt 2 en 5.x van dit pakket"}],
  "unproven": [],
  "branch": "elixir/security-2026-08-28-1308"
}
```

Er gaat alleen een tak omhoog als er echt een pakket bijgewerkt is. Dat de lockfile
veranderde is geen bewijs: npm herschrijft hem ook zonder dat er iets bijgewerkt is, en dan
zou er een voorstel opengaan met de titel "0 pakket(ten) bijwerken" en vier regels ruis
eronder. Dat is precies zoveel waard als het klinkt.

Wat in `unproven` belandt, wordt ook teruggedraaid: een override die niets uithaalt blijft
niet in `package.json` staan. Anders krijg je een voorstel met nul pakketten en één regel
die niets doet.

`unproven` is het bewijs dat ontbrak: het pakket werd bijgewerkt, maar de lockfile draagt de
oude versie nog. Beweren is niet bewijzen.
