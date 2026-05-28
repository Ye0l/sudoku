// Sudoku puzzle generation and solving engine

export type Grid = number[]; // 81 cells, 0 = empty
export type Difficulty = 'easy' | 'medium' | 'hard' | 'expert' | 'master';

export interface ClassicPuzzle {
  board: Grid;
  solution: Grid;
}

// --- Constraint helpers ---

function getRowIndices(row: number): number[] {
  const start = row * 9;
  return Array.from({ length: 9 }, (_, i) => start + i);
}

function getColIndices(col: number): number[] {
  return Array.from({ length: 9 }, (_, i) => i * 9 + col);
}

function getBoxIndices(row: number, col: number): number[] {
  const br = (row / 3 | 0) * 3;
  const bc = (col / 3 | 0) * 3;
  const result: number[] = [];
  for (let r = br; r < br + 3; r++)
    for (let c = bc; c < bc + 3; c++)
      result.push(r * 9 + c);
  return result;
}

export function getPeers(pos: number): number[] {
  const row = (pos / 9) | 0;
  const col = pos % 9;
  const peers = new Set<number>([
    ...getRowIndices(row),
    ...getColIndices(col),
    ...getBoxIndices(row, col),
  ]);
  peers.delete(pos);
  return [...peers];
}

function getCandidates(grid: Grid, pos: number): number[] {
  const row = (pos / 9) | 0;
  const col = pos % 9;
  const used = new Uint8Array(10);
  for (const p of getRowIndices(row)) used[grid[p]] = 1;
  for (const p of getColIndices(col)) used[grid[p]] = 1;
  for (const p of getBoxIndices(row, col)) used[grid[p]] = 1;
  const result: number[] = [];
  for (let n = 1; n <= 9; n++) if (!used[n]) result.push(n);
  return result;
}

// --- Backtracking solver (with MRV heuristic) ---

function solveInternal(grid: Grid, random: boolean, limit: number): number {
  // Find empty cell with minimum remaining values
  let pos = -1;
  let minCount = 10;

  for (let i = 0; i < 81; i++) {
    if (grid[i] !== 0) continue;
    const count = getCandidates(grid, i).length;
    if (count === 0) return 0;
    if (count < minCount) {
      minCount = count;
      pos = i;
      if (count === 1) break;
    }
  }

  if (pos === -1) return 1; // all filled → solved

  let candidates = getCandidates(grid, pos);
  if (random) shuffle(candidates);

  let solutions = 0;
  for (const n of candidates) {
    grid[pos] = n;
    solutions += solveInternal(grid, random, limit - solutions);
    if (solutions >= limit) break;
    grid[pos] = 0;
  }
  return solutions;
}

export function solve(grid: Grid): boolean {
  const copy = [...grid];
  if (solveInternal(copy, false, 1) === 1) {
    copy.forEach((v, i) => { grid[i] = v; });
    return true;
  }
  return false;
}

export function solveRandom(grid: Grid): boolean {
  return solveInternal(grid, true, 1) === 1;
}

export function countSolutions(grid: Grid, limit = 2): number {
  return solveInternal([...grid], false, limit);
}

// --- Utility ---

export function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// --- Puzzle generation ---

const UNITS: number[][] = [
  ...Array.from({ length: 9 }, (_, row) => getRowIndices(row)),
  ...Array.from({ length: 9 }, (_, col) => getColIndices(col)),
  ...Array.from({ length: 9 }, (_, box) => {
    const br = ((box / 3) | 0) * 3;
    const bc = (box % 3) * 3;
    return getBoxIndices(br, bc);
  }),
];

type Technique =
  | 'Naked Single'
  | 'Hidden Single'
  | 'Locked Candidate'
  | 'Naked Pair'
  | 'Hidden Pair'
  | 'Naked Triple'
  | 'Hidden Triple'
  | 'X-Wing'
  | 'Swordfish'
  | 'Forcing Chain'
  | 'Nishio';

interface LogicalReport {
  solved: boolean;
  contradiction: boolean;
  hardestLevel: number;
  placements: number;
  eliminations: number;
  advancedSteps: number;
  techniqueCounts: Partial<Record<Technique, number>>;
}

interface SolverState {
  grid: Grid;
  candidates: number[];
}

const TECHNIQUE_LEVEL: Record<Technique, number> = {
  'Naked Single': 1,
  'Hidden Single': 1,
  'Locked Candidate': 2,
  'Naked Pair': 3,
  'Hidden Pair': 3,
  'Naked Triple': 3,
  'Hidden Triple': 3,
  'X-Wing': 4,
  'Swordfish': 4,
  'Forcing Chain': 5,
  'Nishio': 5,
};

const DIFFICULTY_LEVEL: Record<Difficulty, number> = {
  easy: 1,
  medium: 2,
  hard: 3,
  expert: 4,
  master: 5,
};

const CLASSIC_PROFILES: Record<Difficulty, { targets: number[]; minRemoved: number; attempts: number }> = {
  easy: { targets: [36, 38, 40], minRemoved: 32, attempts: 18 },
  medium: { targets: [50, 52, 54], minRemoved: 45, attempts: 54 },
  hard: { targets: [52, 54, 56], minRemoved: 48, attempts: 72 },
  expert: { targets: [54, 56, 58], minRemoved: 50, attempts: 180 },
  master: { targets: [56, 58, 60, 62], minRemoved: 54, attempts: 120 },
};

interface ClassicTemplate {
  id: string;
  difficulty: Difficulty;
  rating: number;
  puzzle: string;
  solution: string;
}

// Source: Sudoku Exchange Puzzle Bank, public domain, rated with Sukaku Explainer.
const CLASSIC_TEMPLATES: Record<Difficulty, ClassicTemplate[]> = {
  easy: [
    { id: 'easy-se-001', difficulty: 'easy', rating: 1.2, puzzle: '050703060007000800000816000000030000005000100730040086906000204840572093000409000', solution: '158723469367954821294816375619238547485697132732145986976381254841572693523469718' },
    { id: 'easy-se-002', difficulty: 'easy', rating: 1.2, puzzle: '302401809001000300000000000040708010780502036000090000200609003900000008800070005', solution: '372451869691827354458936271543768912789512436126394587215689743937145628864273195' },
    { id: 'easy-se-003', difficulty: 'easy', rating: 1.2, puzzle: '000823001003000400070000052300960010000102000010038006830000040002000900600789000', solution: '594823671263517489178694352327965814486172593915438726839256147752341968641789235' },
    { id: 'easy-se-004', difficulty: 'easy', rating: 1.2, puzzle: '500700032100326000000000000020070058010803040890040070000000000000654001230009005', solution: '569718432148326597372495816423971658715863249896542173651237984987654321234189765' },
    { id: 'easy-se-005', difficulty: 'easy', rating: 1.2, puzzle: '760000053020080040005000900000000000040010070603000104100304009000000000006827300', solution: '764192853329785641815436927271649538948513276653278194182354769537961482496827315' },
    { id: 'easy-se-006', difficulty: 'easy', rating: 1.2, puzzle: '140000050700200000000300204200080400080090020006050001809001000000006007050000069', solution: '142768953735249618698315274213687495584193726976452831869571342421936587357824169' },
    { id: 'easy-se-007', difficulty: 'easy', rating: 1.2, puzzle: '002009000015008760040000051620407000000010000000206074170000090098500610000700800', solution: '762159438915348762843672951621437589487915326539286174174863295398524617256791843' },
    { id: 'easy-se-008', difficulty: 'easy', rating: 1.2, puzzle: '060010030830605029000000000006030900092000570000409000285000716000000000470000095', solution: '567912438834675129921843657146537982392186574758429361285394716619758243473261895' },
    { id: 'easy-se-009', difficulty: 'easy', rating: 1.2, puzzle: '600002305000970016021000009070643000000000000000891040200000530310064000904700001', solution: '698412375453978216721356489172643958849527163536891742267189534315264897984735621' },
    { id: 'easy-se-010', difficulty: 'easy', rating: 1.2, puzzle: '007020850200516000400000006070648090930102068060953020700000005000495002029060100', solution: '617324859298516347453789216172648593935172468864953721746231985381495672529867134' },
  ],
  medium: [
    { id: 'medium-se-001', difficulty: 'medium', rating: 2.3, puzzle: '020900000048000031000063020009407003003080200400105600030570000250000180000006050', solution: '325941768648752931971863524569427813713689245482135679136578492257394186894216357' },
    { id: 'medium-se-002', difficulty: 'medium', rating: 2, puzzle: '100800570000009210090040000300900050007000300020006008000020040071400000064007003', solution: '143862579658739214792541836316978452987254361425316798839625147271493685564187923' },
    { id: 'medium-se-003', difficulty: 'medium', rating: 2.3, puzzle: '002000800005020100460000029130060052009080400000302000006070200700000008020519070', solution: '312947865985623147467851329138764952279185436654392781596478213741236598823519674' },
    { id: 'medium-se-004', difficulty: 'medium', rating: 1.7, puzzle: '802600009000058000006000401090406005020000040600203090205000900000970000100002804', solution: '812634579947158263536729481791486325328597146654213798265841937483975612179362854' },
    { id: 'medium-se-005', difficulty: 'medium', rating: 2.3, puzzle: '070000120100000067000200004200040070710030049090070001300009000950000006067000080', solution: '579486123142395867683217594235941678716538249894672351328769415951824736467153982' },
    { id: 'medium-se-006', difficulty: 'medium', rating: 2.3, puzzle: '054608003700004000800000020690000102000010000203000047070000006000500008900306410', solution: '154628793762934851839157624695743182487215369213869547571482936346591278928376415' },
    { id: 'medium-se-007', difficulty: 'medium', rating: 2.3, puzzle: '000159000015000790000000000100405008280000067500728001000896000098010420000000000', solution: '347159682815642793962387154179465238284931567536728941421896375798513426653274819' },
    { id: 'medium-se-008', difficulty: 'medium', rating: 2.3, puzzle: '000000000340000091701060408800000006010000020600205009060107050005020100030090060', solution: '298341675346758291751962438823479516519836724674215389462187953985623147137594862' },
    { id: 'medium-se-009', difficulty: 'medium', rating: 2, puzzle: '206008309001002000700004012942060000000407000000080423620700004000200500309800206', solution: '256178349431692758798354612942563187183427965567981423625719834874236591319845276' },
    { id: 'medium-se-010', difficulty: 'medium', rating: 1.7, puzzle: '100009570798040000600002000012000008000000000500000320000300005000070416061200003', solution: '123689574798543162654712839912437658386125947547896321479361285235978416861254793' },
  ],
  hard: [
    { id: 'hard-se-001', difficulty: 'hard', rating: 3.4, puzzle: '080200400570000100002300000820090005000715000700020041000006700003000018007009050', solution: '389251467576948132142367589821694375934715826765823941258136794493572618617489253' },
    { id: 'hard-se-002', difficulty: 'hard', rating: 2.6, puzzle: '600050007030000000080409200015300000008000300000007590009501030000000080200070004', solution: '692853147134726859587419263915382476478695321326147598849561732761234985253978614' },
    { id: 'hard-se-003', difficulty: 'hard', rating: 3, puzzle: '000050000000206000064000390045000810000020000000107000053000980090804060100030004', solution: '921453678378296145564781392245369817617528439839147256453672981792814563186935724' },
    { id: 'hard-se-004', difficulty: 'hard', rating: 3.2, puzzle: '970306042805000109000050000207000304010020080400738001000905000000000000100847003', solution: '971386542865472139324159876287591364513624987496738251732965418648213795159847623' },
    { id: 'hard-se-005', difficulty: 'hard', rating: 2.6, puzzle: '000006007007050000054090100090304080003060700010907050006080410000070900900100000', solution: '129836547867451239354792168795314682243568791618927354576289413481673925932145876' },
    { id: 'hard-se-006', difficulty: 'hard', rating: 2.6, puzzle: '000000000003702800060354090089000160070645030000000000040000070200506004000010000', solution: '924168753513792846867354291489237165172645938356981427641823579298576314735419682' },
    { id: 'hard-se-007', difficulty: 'hard', rating: 3.2, puzzle: '103600400590001008000200000809020000207080905000070204000002000600800039005003802', solution: '183695427592741368476238591859124673247386915361579284938412756624857139715963842' },
    { id: 'hard-se-008', difficulty: 'hard', rating: 2.6, puzzle: '300005007010030590020008000708000000090000010000000902000900040032080070400600001', solution: '364195827817432596925768134758219463293846715641357982576921348132584679489673251' },
    { id: 'hard-se-009', difficulty: 'hard', rating: 3.2, puzzle: '200040003600239008000000000029000530850000016006102900070805060900703001000010000', solution: '287541693615239748493678125129486537854397216736152984371825469942763851568914372' },
    { id: 'hard-se-010', difficulty: 'hard', rating: 2.8, puzzle: '869000312020000080070108040030000090700060004001902500000836000400070003000010000', solution: '869457312124693785573128946235741698798365124641982537952836471416279853387514269' },
  ],
  expert: [
    { id: 'expert-se-001', difficulty: 'expert', rating: 4.3, puzzle: '210950004090060037000700000000000308920000015805000000000002000680010040100047096', solution: '217953864598264137346781952761495328924378615835126479479632581682519743153847296' },
    { id: 'expert-se-002', difficulty: 'expert', rating: 4.1, puzzle: '024000650100000007008010900000000000260090083080501070600903008002854700000070000', solution: '924738651156249837738615942597382164261497583483561279675923418312854796849176325' },
    { id: 'expert-se-003', difficulty: 'expert', rating: 4.1, puzzle: '108500406000070900530004007001060008090408070800050600700100069006080000904006205', solution: '178593426462871953539624187341267598695418372827359641753142869216985734984736215' },
    { id: 'expert-se-004', difficulty: 'expert', rating: 4, puzzle: '040000000086100034001500260000305840000040000058902000095008300160009450000000010', solution: '547236981286197534931584267619375842372841695458962173795418326163729458824653719' },
    { id: 'expert-se-005', difficulty: 'expert', rating: 4, puzzle: '045900000000710205020003009008301026010000050360805100200100030801057000000009510', solution: '645982371983716245127543689598371426712694853364825197259168734831457962476239518' },
    { id: 'expert-se-006', difficulty: 'expert', rating: 4.5, puzzle: '900801005000607000870000069490000057080000020000375000040000070008060900109000603', solution: '964821735235697481871534269493286157587149326612375894346912578758463912129758643' },
    { id: 'expert-se-007', difficulty: 'expert', rating: 4.2, puzzle: '060050030000306000007000400030000060014020790700000001000000000900147005051609870', solution: '168754239542396187397812456839471562614523798725968341476285913983147625251639874' },
    { id: 'expert-se-008', difficulty: 'expert', rating: 4.2, puzzle: '500000001020600700780005000904001008000908000200500904000300017009006050600000002', solution: '596782341421693785783415269964231578357948126218567934842359617179826453635174892' },
    { id: 'expert-se-009', difficulty: 'expert', rating: 4.5, puzzle: '600040001030008700009700000003096000906000103000120500000002400002400080400010002', solution: '687245931231968745549731268123596874956874123874123596765382419312459687498617352' },
    { id: 'expert-se-010', difficulty: 'expert', rating: 4.5, puzzle: '200010007000207000050000020005020400001549200300708001070804030000000000630000085', solution: '293615847416287359857493126965321478781549263342768591179854632528936714634172985' },
  ],
  master: [
    { id: 'master-se-001', difficulty: 'master', rating: 7.2, puzzle: '083020090000800100029300008000098700070000060006740000300006980002005000010030540', solution: '183524697547869123629317458235698714471253869896741235354176982962485371718932546' },
    { id: 'master-se-002', difficulty: 'master', rating: 7.1, puzzle: '200050006010000090600801003007090600000703000900080002100000005060902010003060200', solution: '284359176315627894679841523857294631426713958931586742192478365568932417743165289' },
    { id: 'master-se-003', difficulty: 'master', rating: 7.1, puzzle: '590000007040010083008034900001402000069000820000109300004670200980040030700000016', solution: '593826147247915683618734952371482569469357821825169374154673298986241735732598416' },
    { id: 'master-se-004', difficulty: 'master', rating: 8.2, puzzle: '006000200900000004243000896000591000002080300400203001300000007000907000010408020', solution: '576849213981326574243175896837591462162784359495263781358612947624957138719438625' },
    { id: 'master-se-005', difficulty: 'master', rating: 6.6, puzzle: '000000000560000032230040079000060000070501090000708000053000920009806500700000004', solution: '987312645564987132231645879192463758678521493345798261853174926429836517716259384' },
    { id: 'master-se-006', difficulty: 'master', rating: 5.6, puzzle: '000310000060097040001420300030000502786000139502000060003059700020680010000074000', solution: '249316857365897241871425396134968572786542139592731468613259784427683915958174623' },
    { id: 'master-se-007', difficulty: 'master', rating: 6.7, puzzle: '076009400000801007300000009610307080000090000020108034500000006900204000001600790', solution: '176539428295841367348762519614327985853496271729158634582973146967214853431685792' },
    { id: 'master-se-008', difficulty: 'master', rating: 5.4, puzzle: '103070002000000040090005001020100503007000200405002060200800030050000000800020709', solution: '183674952562981347794235681928146573617358294435792168271869435359417826846523719' },
    { id: 'master-se-009', difficulty: 'master', rating: 7.2, puzzle: '850000031000070000000809000003000600970301052000020000100407006205000307000080000', solution: '857642931492173865361859274523794618978361452614528793189437526245916387736285149' },
    { id: 'master-se-010', difficulty: 'master', rating: 6.3, puzzle: '031006009000040060008007300184070020000000000090020148005800400040060000300500780', solution: '431286579957143862268957314184379625526418937793625148675832491849761253312594786' },
  ],
};

function parseGridString(value: string): Grid {
  return Array.from(value, char => Number(char));
}

function relabelDigits(grid: Grid, map: number[]): Grid {
  return grid.map(value => value === 0 ? 0 : map[value]);
}

function transposeGrid(grid: Grid): Grid {
  const next = new Array(81).fill(0);
  for (let r = 0; r < 9; r++)
    for (let c = 0; c < 9; c++)
      next[r * 9 + c] = grid[c * 9 + r];
  return next;
}

function rotateGrid(grid: Grid): Grid {
  const next = new Array(81).fill(0);
  for (let r = 0; r < 9; r++)
    for (let c = 0; c < 9; c++)
      next[r * 9 + c] = grid[(8 - c) * 9 + r];
  return next;
}

function reflectGrid(grid: Grid): Grid {
  const next = new Array(81).fill(0);
  for (let r = 0; r < 9; r++)
    for (let c = 0; c < 9; c++)
      next[r * 9 + c] = grid[r * 9 + (8 - c)];
  return next;
}

function shuffledUnitOrder(): number[] {
  const groups = shuffle([0, 1, 2]);
  const order: number[] = [];
  for (const group of groups) {
    for (const offset of shuffle([0, 1, 2])) order.push(group * 3 + offset);
  }
  return order;
}

function permuteRowsAndColumns(grid: Grid, rows: number[], cols: number[]): Grid {
  const next = new Array(81).fill(0);
  for (let r = 0; r < 9; r++)
    for (let c = 0; c < 9; c++)
      next[r * 9 + c] = grid[rows[r] * 9 + cols[c]];
  return next;
}

function transformTemplate(template: ClassicTemplate): ClassicPuzzle {
  const digitMap = [0, ...shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9])];
  let board = relabelDigits(parseGridString(template.puzzle), digitMap);
  let solution = relabelDigits(parseGridString(template.solution), digitMap);

  if (Math.random() < 0.5) {
    board = transposeGrid(board);
    solution = transposeGrid(solution);
  }

  const rotations = (Math.random() * 4) | 0;
  for (let i = 0; i < rotations; i++) {
    board = rotateGrid(board);
    solution = rotateGrid(solution);
  }

  if (Math.random() < 0.5) {
    board = reflectGrid(board);
    solution = reflectGrid(solution);
  }

  const rows = shuffledUnitOrder();
  const cols = shuffledUnitOrder();
  board = permuteRowsAndColumns(board, rows, cols);
  solution = permuteRowsAndColumns(solution, rows, cols);
  return { board, solution };
}

function generateFromTemplate(difficulty: Difficulty): ClassicPuzzle {
  const templates = CLASSIC_TEMPLATES[difficulty];
  return transformTemplate(templates[(Math.random() * templates.length) | 0]);
}

function countRemoved(board: Grid): number {
  let removed = 0;
  for (const value of board) if (value === 0) removed++;
  return removed;
}

function candidateMask(grid: Grid, pos: number): number {
  let mask = 0b1111111110;
  for (const peer of getPeers(pos)) {
    const value = grid[peer];
    if (value !== 0) mask &= ~(1 << value);
  }
  return mask;
}

function maskSize(mask: number): number {
  let count = 0;
  for (let n = 1; n <= 9; n++) if (mask & (1 << n)) count++;
  return count;
}

function maskSingle(mask: number): number {
  for (let n = 1; n <= 9; n++) if (mask === (1 << n)) return n;
  return 0;
}

function maskDigits(mask: number): number[] {
  const digits: number[] = [];
  for (let n = 1; n <= 9; n++) if (mask & (1 << n)) digits.push(n);
  return digits;
}

function addTechnique(report: LogicalReport, technique: Technique, amount = 1): void {
  report.techniqueCounts[technique] = (report.techniqueCounts[technique] ?? 0) + amount;
  report.hardestLevel = Math.max(report.hardestLevel, TECHNIQUE_LEVEL[technique]);
  if (TECHNIQUE_LEVEL[technique] >= 4) report.advancedSteps += amount;
}

function createSolverState(board: Grid): SolverState {
  const state: SolverState = {
    grid: [...board],
    candidates: new Array(81).fill(0),
  };

  for (let pos = 0; pos < 81; pos++) {
    state.candidates[pos] = state.grid[pos] === 0 ? candidateMask(state.grid, pos) : 0;
  }

  return state;
}

function hasContradiction(state: SolverState): boolean {
  for (let pos = 0; pos < 81; pos++) {
    if (state.grid[pos] === 0 && state.candidates[pos] === 0) return true;
  }

  for (const unit of UNITS) {
    for (let n = 1; n <= 9; n++) {
      const bit = 1 << n;
      let placed = 0;
      let possible = 0;
      for (const pos of unit) {
        if (state.grid[pos] === n) placed++;
        if (state.grid[pos] === 0 && (state.candidates[pos] & bit)) possible++;
      }
      if (placed > 1 || (placed === 0 && possible === 0)) return true;
    }
  }

  return false;
}

function placeDigit(state: SolverState, pos: number, digit: number): boolean {
  if (state.grid[pos] === digit) return false;
  state.grid[pos] = digit;
  state.candidates[pos] = 0;
  const bit = 1 << digit;
  for (const peer of getPeers(pos)) {
    if (state.grid[peer] === 0) state.candidates[peer] &= ~bit;
  }
  return true;
}

function eliminateMask(state: SolverState, pos: number, mask: number): boolean {
  if (state.grid[pos] !== 0) return false;
  const next = state.candidates[pos] & ~mask;
  if (next === state.candidates[pos]) return false;
  state.candidates[pos] = next;
  return true;
}

function combinations<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  const combo: T[] = [];

  function visit(start: number): void {
    if (combo.length === size) {
      result.push([...combo]);
      return;
    }
    for (let i = start; i <= items.length - (size - combo.length); i++) {
      combo.push(items[i]);
      visit(i + 1);
      combo.pop();
    }
  }

  visit(0);
  return result;
}

function applySingles(state: SolverState, report: LogicalReport): boolean {
  for (let pos = 0; pos < 81; pos++) {
    if (state.grid[pos] !== 0) continue;
    const single = maskSingle(state.candidates[pos]);
    if (single !== 0) {
      placeDigit(state, pos, single);
      report.placements++;
      addTechnique(report, 'Naked Single');
      return true;
    }
  }

  for (const unit of UNITS) {
    for (let n = 1; n <= 9; n++) {
      const bit = 1 << n;
      let onlyPos = -1;
      let count = 0;
      for (const pos of unit) {
        if (state.grid[pos] !== 0 || (state.candidates[pos] & bit) === 0) continue;
        onlyPos = pos;
        count++;
        if (count > 1) break;
      }
      if (count === 1) {
        placeDigit(state, onlyPos, n);
        report.placements++;
        addTechnique(report, 'Hidden Single');
        return true;
      }
    }
  }

  return false;
}

function applyLockedCandidates(state: SolverState, report: LogicalReport): boolean {
  for (let box = 0; box < 9; box++) {
    const boxCells = UNITS[18 + box];
    for (let n = 1; n <= 9; n++) {
      const bit = 1 << n;
      const cells = boxCells.filter(pos => state.grid[pos] === 0 && (state.candidates[pos] & bit));
      if (cells.length < 2) continue;
      const sameRow = cells.every(pos => (pos / 9 | 0) === (cells[0] / 9 | 0));
      const sameCol = cells.every(pos => pos % 9 === cells[0] % 9);
      const unit = sameRow ? getRowIndices(cells[0] / 9 | 0) : sameCol ? getColIndices(cells[0] % 9) : null;
      if (!unit) continue;
      for (const pos of unit) {
        if (!boxCells.includes(pos) && eliminateMask(state, pos, bit)) {
          report.eliminations++;
          addTechnique(report, 'Locked Candidate');
          return true;
        }
      }
    }
  }

  for (let unitIndex = 0; unitIndex < 18; unitIndex++) {
    const unit = UNITS[unitIndex];
    for (let n = 1; n <= 9; n++) {
      const bit = 1 << n;
      const cells = unit.filter(pos => state.grid[pos] === 0 && (state.candidates[pos] & bit));
      if (cells.length < 2) continue;
      const box = getBoxIndex(cells[0]);
      if (!cells.every(pos => getBoxIndex(pos) === box)) continue;
      for (const pos of UNITS[18 + box]) {
        if (!unit.includes(pos) && eliminateMask(state, pos, bit)) {
          report.eliminations++;
          addTechnique(report, 'Locked Candidate');
          return true;
        }
      }
    }
  }

  return false;
}

function subsetTechnique(size: 2 | 3, hidden: boolean): Technique {
  if (hidden) return size === 2 ? 'Hidden Pair' : 'Hidden Triple';
  return size === 2 ? 'Naked Pair' : 'Naked Triple';
}

function applySubsets(state: SolverState, report: LogicalReport, size: 2 | 3, hidden: boolean): boolean {
  const technique = subsetTechnique(size, hidden);

  for (const unit of UNITS) {
    if (!hidden) {
      const cells = unit.filter(pos => state.grid[pos] === 0 && maskSize(state.candidates[pos]) >= 2 && maskSize(state.candidates[pos]) <= size);
      for (const combo of combinations(cells, size)) {
        const union = combo.reduce((mask, pos) => mask | state.candidates[pos], 0);
        if (maskSize(union) !== size) continue;
        for (const pos of unit) {
          if (!combo.includes(pos) && eliminateMask(state, pos, union)) {
            report.eliminations++;
            addTechnique(report, technique);
            return true;
          }
        }
      }
    } else {
      for (const digits of combinations([1, 2, 3, 4, 5, 6, 7, 8, 9], size)) {
        const digitMask = digits.reduce((mask, digit) => mask | (1 << digit), 0);
        const cells = unit.filter(pos => state.grid[pos] === 0 && (state.candidates[pos] & digitMask));
        if (cells.length !== size) continue;
        if (!digits.every(digit => cells.some(pos => state.candidates[pos] & (1 << digit)))) continue;
        for (const pos of cells) {
          if (eliminateMask(state, pos, state.candidates[pos] & ~digitMask)) {
            report.eliminations++;
            addTechnique(report, technique);
            return true;
          }
        }
      }
    }
  }

  return false;
}

function applyFish(state: SolverState, report: LogicalReport, size: 2 | 3): boolean {
  const technique: Technique = size === 2 ? 'X-Wing' : 'Swordfish';

  for (let n = 1; n <= 9; n++) {
    const bit = 1 << n;
    for (const byRows of [true, false]) {
      const baseUnits = byRows ? UNITS.slice(0, 9) : UNITS.slice(9, 18);
      const lineOptions = baseUnits
        .map((unit, index) => ({
          index,
          positions: unit.filter(pos => state.grid[pos] === 0 && (state.candidates[pos] & bit)),
        }))
        .filter(line => line.positions.length >= 2 && line.positions.length <= size);

      for (const lines of combinations(lineOptions, size)) {
        const cover = new Set<number>();
        lines.forEach(line => line.positions.forEach(pos => cover.add(byRows ? pos % 9 : (pos / 9) | 0)));
        if (cover.size !== size) continue;
        const lineSet = new Set(lines.map(line => line.index));

        for (const coverIndex of cover) {
          const unit = byRows ? getColIndices(coverIndex) : getRowIndices(coverIndex);
          for (const pos of unit) {
            const lineIndex = byRows ? ((pos / 9) | 0) : pos % 9;
            if (!lineSet.has(lineIndex) && eliminateMask(state, pos, bit)) {
              report.eliminations++;
              addTechnique(report, technique);
              return true;
            }
          }
        }
      }
    }
  }

  return false;
}

function cloneState(state: SolverState): SolverState {
  return { grid: [...state.grid], candidates: [...state.candidates] };
}

function applyForcingElimination(state: SolverState, report: LogicalReport, maxAssumptions: number): boolean {
  const candidates = Array.from({ length: 81 }, (_, pos) => pos)
    .filter(pos => state.grid[pos] === 0 && maskSize(state.candidates[pos]) >= 2)
    .sort((a, b) => maskSize(state.candidates[a]) - maskSize(state.candidates[b]))
    .slice(0, maxAssumptions);

  for (const pos of candidates) {
    for (const digit of maskDigits(state.candidates[pos])) {
      const trial = cloneState(state);
      placeDigit(trial, pos, digit);
      const trialReport = solveLogical(trial, 4, false, 160);
      if (trialReport.contradiction && eliminateMask(state, pos, 1 << digit)) {
        report.eliminations++;
        addTechnique(report, trialReport.advancedSteps > 0 ? 'Forcing Chain' : 'Nishio');
        return true;
      }
    }
  }

  return false;
}

function solveLogical(input: Grid | SolverState, maxLevel: number, allowForcing = true, stepLimit = 500): LogicalReport {
  const state = Array.isArray(input) ? createSolverState(input) : input;
  const report: LogicalReport = {
    solved: false,
    contradiction: hasContradiction(state),
    hardestLevel: 0,
    placements: 0,
    eliminations: 0,
    advancedSteps: 0,
    techniqueCounts: {},
  };

  for (let step = 0; step < stepLimit && !report.contradiction; step++) {
    if (countRemoved(state.grid) === 0) {
      report.solved = true;
      return report;
    }

    const progress =
      applySingles(state, report)
      || (maxLevel >= 2 && applyLockedCandidates(state, report))
      || (maxLevel >= 3 && applySubsets(state, report, 2, false))
      || (maxLevel >= 3 && applySubsets(state, report, 2, true))
      || (maxLevel >= 3 && applySubsets(state, report, 3, false))
      || (maxLevel >= 3 && applySubsets(state, report, 3, true))
      || (maxLevel >= 4 && applyFish(state, report, 2))
      || (maxLevel >= 4 && applyFish(state, report, 3))
      || (allowForcing && maxLevel >= 5 && applyForcingElimination(state, report, maxLevel === 5 ? 16 : 8));

    report.contradiction = hasContradiction(state);
    if (!progress) break;
  }

  report.solved = !report.contradiction && countRemoved(state.grid) === 0;
  return report;
}

function difficultyMatch(report: LogicalReport, difficulty: Difficulty): boolean {
  if (!report.solved || report.contradiction) return false;
  const targetLevel = DIFFICULTY_LEVEL[difficulty];
  if (report.hardestLevel !== targetLevel) return false;
  if (difficulty === 'master' && report.advancedSteps < 2) return false;
  return true;
}

function measureLogicalDifficulty(board: Grid): LogicalReport {
  let lastReport = solveLogical(board, 5);
  for (let level = 1; level <= 5; level++) {
    const report = solveLogical(board, level);
    if (report.solved) return report;
    lastReport = report;
  }
  return lastReport;
}

function rateClassicBoard(board: Grid, report: LogicalReport, difficulty: Difficulty): number {
  const targetLevel = DIFFICULTY_LEVEL[difficulty];
  const removed = countRemoved(board);
  const levelDistance = Math.abs(report.hardestLevel - targetLevel);
  return (difficultyMatch(report, difficulty) ? 100000 : 0)
    - levelDistance * (report.hardestLevel > targetLevel ? 26000 : 14000)
    + removed * 180
    + report.placements * 4
    + report.eliminations * 22
    + (report.hardestLevel <= targetLevel ? report.advancedSteps * 900 : 0);
}

export function analyzeClassicDifficulty(board: Grid): LogicalReport {
  return measureLogicalDifficulty(board);
}

function selectTargetRemoved(profile: { targets: number[] }, attempt: number): number {
  return profile.targets[attempt % profile.targets.length];
}

function generateSolution(): Grid {
  const solution: Grid = new Array(81).fill(0);
  solveInternal(solution, true, 1);
  return solution;
}

function carveClassicBoard(solution: Grid, targetRemoved: number): Grid {
  const board = [...solution];
  const positions = shuffle(Array.from({ length: 81 }, (_, i) => i));
  let removed = 0;

  for (const pos of positions) {
    if (removed >= targetRemoved) break;
    const backup = board[pos];
    board[pos] = 0;
    if (countSolutions(board, 2) === 1) {
      removed++;
    } else {
      board[pos] = backup;
    }
  }

  return board;
}

function seedSparseUniqueBoard(solution: Grid, minGivenCount: number, maxGivenCount: number): Grid | null {
  const board: Grid = new Array(81).fill(0);
  const positions = shuffle(Array.from({ length: 81 }, (_, i) => i));
  let givenCount = 0;

  for (const pos of positions) {
    board[pos] = solution[pos];
    givenCount++;
    if (givenCount < minGivenCount) continue;
    if (countSolutions(board, 2) === 1) return board;
    if (givenCount >= maxGivenCount) break;
  }

  return null;
}

export function generateClassicPuzzle(difficulty: Difficulty): ClassicPuzzle {
  return generateFromTemplate(difficulty);
}

// --- Validation ---

export function isValidPlacement(board: Grid, pos: number, value: number): boolean {
  const row = (pos / 9) | 0;
  const col = pos % 9;
  for (const p of getRowIndices(row)) if (board[p] === value) return false;
  for (const p of getColIndices(col)) if (board[p] === value) return false;
  for (const p of getBoxIndices(row, col)) if (board[p] === value) return false;
  return true;
}

export function getBoxIndex(pos: number): number {
  const row = (pos / 9) | 0;
  const col = pos % 9;
  return ((row / 3) | 0) * 3 + ((col / 3) | 0);
}
