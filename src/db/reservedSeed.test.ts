import { expect } from "jsr:@std/expect";
import { sha256 } from "npm:@noble/hashes@1.3.1/sha256";
import { bytesToHex, utf8ToBytes } from "npm:@noble/hashes@1.3.1/utils";
import { usernameProblem } from "./userValues.ts";

/** Places and historical figures. Every one is assignable unless an existing hard row already owns the name. */
const PLACES = [
  "buenosaires", "catamarca", "chaco", "chubut", "cordoba", "corrientes", "entrerios", "formosa",
  "jujuy", "lapampa", "larioja", "mendoza", "misiones", "neuquen", "rionegro", "salta", "sanjuan",
  "sanluis", "santacruz", "santafe", "santiagodelestero", "tierradelfuego", "tucuman", "caba",
  "capitalfederal", "antartidaargentina", "malvinas", "islasmalvinas", "patagonia", "cuyo", "noa",
  "nea", "litoral", "bariloche", "sancarlosdebariloche", "sanmartindelosandes", "villalaangostura",
  "elbolson", "junindelosandes", "villapehuenia", "caviahue", "copahue", "alumine", "chosmalal",
  "elcalafate", "elchalten", "ushuaia", "tolhuin", "riogallegos", "losantiguos", "peritomoreno",
  "puertomadryn", "puertopiramides", "peninsulavaldes", "trelew", "esquel", "trevelin", "cholila",
  "rawson", "caletaolivia", "iguazu", "puertoiguazu", "posadas", "cafayate", "cachi", "tilcara",
  "purmamarca", "humahuaca", "quebradadehumahuaca", "sansalvadordejujuy", "mardelplata", "pinamar",
  "villagesell", "necochea", "miramar", "montehermoso", "tandil", "sierradelaventana", "chascomus",
  "sanantoniodeareco", "tigre", "laplata", "rosario", "parana", "colon", "gualeguaychu", "merlo",
  "villacarlospaz", "carlospaz", "altagracia", "villageneralbelgrano", "lacumbrecita", "capilladelmonte",
  "sanrafael", "malargue", "uspallata", "tupungato", "valledeuco", "lujandecuyo", "maipu", "potrerillos",
  "laslenas", "aconcagua", "chilecito", "talampaya", "ischigualasto", "vallefertil", "termasderiohondo",
  "esterosdelibera", "ibera", "cerrocatedral", "chapelco", "cerrocastor",
];

const FIGURES = [
  "sanmartin", "josedesanmartin", "belgrano", "manuelbelgrano", "sarmiento", "domingosarmiento",
  "rivadavia", "marianomoreno", "guemes", "martinguemes", "juanaazurduy", "rosas", "juanmanuelderosas",
  "urquiza", "mitre", "bartolomemitre", "roca", "alberdi", "juanbautistaalberdi", "evita", "evaperon",
  "peron", "juanperon", "yrigoyen", "hipolitoyrigoyen", "alem", "leandroalem", "cheguevara", "borges",
  "gardel", "carlosgardel", "favaloro", "houssay", "leloir", "milstein", "maradona", "castelli",
  "saavedra", "pueyrredon", "guillermobrown", "almirantebrown", "piedrabuena", "franciscomoreno",
  "ceferinonamuncura", "namuncura", "calfucura", "alfonsinastorni", "mercedessosa", "atahualpayupanqui",
  "quino", "cortazar", "ernestosabato", "dorrego", "lavalle", "paz", "facundoquiroga", "azurduy",
];

const ADDITIONS = [...PLACES, ...FIGURES];

/** Hard exact names already in 0006 before this addition. They must not change category. */
const HARD_EXACT_SHA256 = "59bbf49649f527c0dc0acb0a2cf6b6b5ae6c7d82c8868dd50cc6c7b6c50d6467";

type Row = { name: string; category: "hard" | "assignable"; match: "exact" | "prefix" | "contains" };

function seedRows(sql: string): Row[] {
  return [...sql.matchAll(/\('([a-z0-9]+)', '(hard|assignable)', '(exact|prefix|contains)'\)/g)].map((match) => ({
    name: match[1],
    category: match[2] as Row["category"],
    match: match[3] as Row["match"],
  }));
}

Deno.test("the 0006 seed keeps every new place and figure as assignable exact", async () => {
  const sql = await Deno.readTextFile(new URL("../../drizzle/0006_reserved_usernames.sql", import.meta.url));
  const rows = seedRows(sql);
  const exact = new Map<string, string>();
  const pairs = new Set<string>();
  for (const row of rows) {
    const pair = `${row.name}|${row.match}`;
    expect(pairs.has(pair)).toEqual(false);
    pairs.add(pair);
    if (row.match === "exact") {
      expect(exact.has(row.name)).toEqual(false);
      exact.set(row.name, row.category);
    }
  }

  const hardExact = [...exact.entries()].filter(([, category]) => category === "hard").map(([name]) => name).sort();
  expect(bytesToHex(sha256(utf8ToBytes(hardExact.join("\n"))))).toEqual(HARD_EXACT_SHA256);
  expect(rows.filter((row) => row.match === "prefix").map((row) => row.name).sort()).toEqual([
    "admin", "ayuda", "billing", "help", "mod", "official", "oficial", "security", "soporte", "staff",
    "support", "team", "travelsats", "zuricata",
  ]);
  expect(rows.filter((row) => row.match === "contains").map((row) => row.name).sort()).toEqual([
    "travelsats", "zuricata",
  ]);

  const dropped: string[] = [];
  const keptHard: string[] = [];
  for (const name of ADDITIONS) {
    const problem = usernameProblem(name);
    if (problem) {
      dropped.push(`${name}:${problem}`);
      expect(exact.has(name)).toEqual(false);
      continue;
    }
    if (hardExact.includes(name)) {
      keptHard.push(name);
      expect(exact.get(name)).toEqual("hard");
      continue;
    }
    expect(exact.get(name)).toEqual("assignable");
  }
  expect(dropped).toEqual([]);
  expect(keptHard).toEqual([]);
  for (const name of ["calafate", "chalten", "payunia", "hello", "zuricata"]) {
    expect({ name, category: exact.get(name) }).toEqual({
      name,
      category: name === "hello" || name === "zuricata" ? "hard" : "assignable",
    });
  }
  // 19 of the additions are already assignable exact rows. 151 are new. None replace a hard row.
  expect(rows.filter((row) => row.category === "assignable").length).toEqual(173);
  expect(rows.filter((row) => row.category === "hard").length).toEqual(358);
});
