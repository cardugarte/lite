import { expect } from "jsr:@std/expect";
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

type Row = { name: string; category: "hard" | "assignable"; match: "exact" | "prefix" | "contains" };

function seedRows(sql: string): Row[] {
  return [...sql.matchAll(/\('([a-z0-9]+)', '(hard|assignable)', '(exact|prefix|contains)'\)/g)].map((match) => ({
    name: match[1],
    category: match[2] as Row["category"],
    match: match[3] as Row["match"],
  }));
}

Deno.test("the 0006 seed is entirely assignable, with no hard rows", async () => {
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

  const prefixes = rows.filter((row) => row.match === "prefix");
  expect(prefixes.map((row) => row.name).sort()).toEqual([
    "admin", "ayuda", "billing", "help", "mod", "official", "oficial", "security", "soporte", "staff",
    "support", "team", "travelsats", "zuricata",
  ]);
  expect(prefixes.every((row) => row.category === "assignable")).toEqual(true);
  const contains = rows.filter((row) => row.match === "contains");
  expect(contains.map((row) => row.name).sort()).toEqual(["travelsats", "zuricata"]);
  expect(contains.every((row) => row.category === "assignable")).toEqual(true);

  const dropped: string[] = [];
  for (const name of ADDITIONS) {
    const problem = usernameProblem(name);
    if (problem) {
      dropped.push(`${name}:${problem}`);
      expect(exact.has(name)).toEqual(false);
      continue;
    }
    expect(exact.get(name)).toEqual("assignable");
  }
  expect(dropped).toEqual([]);
  for (const name of ["admin", "api", "root", "travelsats", "hello", "zuricata", "calafate", "payunia"]) {
    expect(exact.get(name)).toEqual("assignable");
  }
  expect(rows.filter((row) => row.category === "hard").length).toEqual(0);
  expect(rows.filter((row) => row.category === "assignable").length).toEqual(531);
  expect(rows.filter((row) => row.match === "exact").length).toEqual(515);
});
