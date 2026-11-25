'use strict';

/* Vault Galaxy 1.1.2 — your vault as a living orbital galaxy.
 *
 * Core idea: choreographed orbits, not simulated gravity. Every node gets an
 * assigned parent, radius, speed and phase -> deterministic ellipses that read
 * as physics and can never destabilize. Orbit radius encodes link strength
 * (more linked = tighter orbit). Layout is seeded by file-path hashes, so the
 * galaxy looks the same every time you open it.
 *
 * On top of the orbits sits a coupled displacement field: grab any node and
 * drag it — its linked neighbors are tugged toward it (spring stiffness scales
 * with link weight); release and the disturbed web wobbles back to rest.
 */

const { Plugin, ItemView, TFile, Notice, PluginSettingTab, Setting } = require('obsidian');

const VIEW_TYPE = 'vault-galaxy-folders-view';
const GOLDEN = 2.399963229728653; // golden angle, for collision-free phase spacing

// fixed tiers; folder groups get palette colors (overridable in the view panel)
const TIERS = {
  core:    { color: '#ffd54a', label: 'core' },
  hub:     { color: '#ff9d2e', label: 'hub' },
  other:   { color: '#93a4b8', label: 'misc' },
  archive: { color: '#5c6470', label: 'archive' },
  folder:  { color: '#e8d9a8', label: 'folders' },
};
const GROUP_PALETTE = [
  '#9fc7a5', '#b18cff', '#5fdd8f', '#59c2f0', '#e88bc4', '#43d9c0',
  '#f2a65a', '#8fa8ff', '#d4c95a', '#f28b8b', '#7fd0c0', '#c39bd3',
];
const MAX_GROUPS = 12;

// Kepler-ish speed constants per tier: omega = K / r^1.5  (rad/s at speed 1x)
const SPEED_K = { core: 46, hub: 210, leaf: 64, anchor: 260, archive: 200, disc: 335, folder: 200 };

// planets view, multi-source lighting: every sun and hub is a light source.
// Directionality = |weighted direction sum| / weight sum (1 = one source
// dominates, 0 = lit evenly from all sides). Above CRISP the sharp-crescent
// sprite renders, below SOFT the near-ambient one, crossfaded in between.
const PLANET_LIGHT = { CRISP: 0.75, SOFT: 0.45 };
const PLANET_LEVELS = [
  { L: [0.87, 0, 0.5], amb: 0.16, t0: -0.06, t1: 0.22, night: 0.07 }, // crisp crescent
  { L: [0.6, 0, 0.8], amb: 0.34, t0: -0.28, t1: 0.5, night: 0.2 },    // soft
  { L: [0.26, 0, 0.97], amb: 0.55, t0: -0.7, t1: 0.9, night: 0.38 },  // near-ambient
];

// displacement-field physics (the interactive grab/ripple layer).
// Damping is NOT a constant: each node gets a damping coefficient scaled to
// its own total stiffness and mass (c = zeta * 2 * sqrt(k_total * m)), so
// every node shares one designed damping ratio (the "bounciness" setting)
// instead of inheriting whatever its link count implies. Mass follows tier:
// suns lumber and carry momentum, dust gets whipped around.
const PHYS = {
  K_HOME: 14,   // home spring toward the natural orbit
  K_LINK: 7,    // per-link coupling spring (scaled by link weight)
  F_CAP: 1500,  // per-node force clamp (stability guard, not a tuning knob)
  V_CAP: 900,   // velocity clamp — also the max throw speed
  MASS: { sun: 10, coreFolder: 8, hubFolder: 4, hub: 3.5, folder: 4, note: 1, archive: 0.8 },
};

// galaxy-mode disc: unlinked notes seeded along spiral arms that shear
// naturally under differential rotation
const DISC_TWIST = 0.0045;   // rad per world-unit of radius
const DISC_INNER = 240;
const DISC_SPAN = 560;

// tilted (2.5D) views: fixed cinematic pitches with mild perspective. The
// simulation never leaves the flat 2D plane — only the camera tilts, and each
// node carries a small stable z-offset (seeded by path) so the tiers separate
// into a bulge-and-disc profile: suns hug the mid-plane, dust scatters wide.
const TILT = {
  ANGLES: { flat: 0, tilt: 38 * (Math.PI / 180), steep: 62 * (Math.PI / 180) },
  FOCAL: 2400,          // perspective distance in world units (mild foreshortening)
  Z_BAND: { sun: 6, coreFolder: 8, hubFolder: 14, hub: 14, folder: 18, note: 38, archive: 46 }, // per-tier |z| half-band
  SPIN_RATE: 0.02,      // idle drift speed, rad/s (~5 min per turn)
  SPIN_IDLE_MS: 4000,   // hands-off delay before the drift resumes
};

const DEFAULT_SETTINGS = {
  // --- vault structure rules (Settings tab). Empty = auto-detect.
  coreRules: '',      // one glob per line, e.g. "notes/core_*" — these become suns
  hubRules: '',       // one glob per line — these become orange hub stars
  archiveFolders: '', // one folder per line — rendered as dim rim debris
  folderGroups: '',   // one folder per line for colored clusters; empty = top-level folders
  // --- view
  showFolders: true,  // folders as nodes (linked to their notes and parent folder)
  folderSize: 1,      // folder node size multiplier (on top of node size)
  folderRing: true,   // outer ring around folder nodes
  folderLabels: true, // show folder names
  folderLabelSize: 11, // folder name font size (px)
  folderLineWidth: 1,  // folder tree line thickness multiplier
  folderLineAlpha: 1,  // folder tree line brightness multiplier
  folderLineColor: '', // folder tree line color; empty = same as the folder color
  folderSpread: 1,     // distance of folders from the center / their parents (rebuilds)
  autoCoreCount: 5,    // how many most-linked notes become suns when no core rule matches (0 = none)
  autoHubCount: 8,     // how many next most-linked notes become hubs when no hub rule matches (0 = none)
  excludeRules: '',    // notes (globs) that are never auto-promoted to core/hub
  folderAsHub: false,  // subfolders (depth 2+) drawn as hub notes
  folderColors: {},    // per-folder color: { 'Projects': '#hex', 'Projects/Alpha': '#hex' } (inherited by subfolders and notes)
  coreLayout: 'orbit', // 'orbit' | 'center' (biggest core in the middle) | 'fixed' (centered, others don't orbit)
  coreBrightness: 1,   // brightness of core nodes (glow, corona, body)
  coreCenterColor: '#fff7d8', // color of the hot center of core nodes
  folderLabelZoom: 0,  // folder-name label threshold (0 = same as the general label threshold)
  folderAsCore: false, // folders drawn as suns (core notes): gold, big, with corona; they light the planets
  folderCoreLevel: 'top', // 'top' = only top-level folders | 'all' = every folder
  mode: 'galaxy',     // 'galaxy' | 'expand'
  tilt: 'steep',      // camera pitch: 'flat' (2D) | 'tilt' | 'steep'
  idleSpin: true,     // tilted views only: slow auto-drift after a few idle seconds
  nodeStyle: 'disc',  // 'disc' (classic) | 'planet' (leaf notes as planets lit by the core)
  corona: true,       // flaring corona on the suns and hubs (rides on the glow setting)
  coronaStrength: 2.15, // how far the corona reaches
  gravity: 1.48,      // orbit tightness; radii /= g, omega *= g^1.5 (Kepler-consistent)
  bounciness: 1,      // 0 = grabbed nodes return dead, 1 = long pendulum ring (damping ratio)
  speed: 0.5,         // rotation speed multiplier
  arms: 6,            // spiral arms (galaxy mode)
  nodeSize: 0.65,     // node radius multiplier
  sunLabels: false,   // core names always on; off = fade in on zoom like everything else
  labelZoom: 3,       // label fade threshold: higher = must zoom in further before names appear
  glow: 0.3,          // glow intensity (0 disables the glow pass)
  linkWidth: 1.3,     // constellation line thickness
  linkAlpha: 3,       // constellation line brightness
  colors: {},         // per-tier/per-group overrides, e.g. { core: '#ffd54a', 'g:Projects': '#5fdd8f' }
};

/* ------------------------------------------------- structure rules */

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function compileGlobs(text) {
  const pats = String(text || '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const res = pats.map((p) => new RegExp('^' + p.split('*').map(escapeRe).join('.*') + '(\\.md)?$'));
  return (path) => res.some((r) => r.test(path));
}

function compileFolders(text) {
  const dirs = String(text || '').split(/\n+/).map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  return (path) => dirs.find((d) => path === d || path.startsWith(d + '/')) || null;
}

// --- deterministic per-path randomness so the layout is stable across opens
function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rand01(seed) { // one-shot mulberry32 step
  let t = (seed + 0x6D2B79F5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function tint(color, f) { // f > 0 mixes a #rrggbb toward white, f < 0 toward black
  const n = parseInt(color.slice(1), 16);
  const ch = (x) => Math.round(f >= 0 ? x + (255 - x) * f : x * (1 + f));
  return `rgb(${ch((n >> 16) & 255)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
}

// per-folder color: nearest ancestor-or-self override wins (inherited by subfolders and notes)
function folderOverride(settings, path) {
  const fc = settings.folderColors;
  if (!fc) return null;
  let d = path;
  while (d) {
    if (fc[d]) return fc[d];
    const i = d.lastIndexOf('/');
    d = i < 0 ? '' : d.slice(0, i);
  }
  return null;
}

// every folder that holds markdown notes (or holds folders that do), in tree order
function listVaultFolders(app) {
  const set = new Set();
  for (const f of app.vault.getMarkdownFiles()) {
    let d = f.path.lastIndexOf('/') < 0 ? '' : f.path.slice(0, f.path.lastIndexOf('/'));
    while (d && !set.has(d)) { set.add(d); const i = d.lastIndexOf('/'); d = i < 0 ? '' : d.slice(0, i); }
  }
  return [...set].sort((a, b) => {
    const A = a.split('/'), B = b.split('/');
    for (let i = 0; i < Math.min(A.length, B.length); i++) {
      if (A[i] !== B[i]) return A[i].localeCompare(B[i]);
    }
    return A.length - B.length;
  });
}

function prettify(path) {
  let n = path.split('/').pop().replace(/\.md$/, '');
  n = n.replace(/^core_/, '').replace(/^hub_/, '').replace(/[_-]+/g, ' ');
  return n.length > 30 ? n.slice(0, 29) + '…' : n;
}

/* ------------------------------------------------------------------ model */

function buildModel(app, settings) {
  const mode = settings.mode === 'expand' ? 'expand' : 'galaxy';
  const isArchive = compileFolders(settings.archiveFolders);
  const isCore = compileGlobs(settings.coreRules);
  const isHub = compileGlobs(settings.hubRules);
  const groupOf = compileFolders(settings.folderGroups);
  const autoGroups = !String(settings.folderGroups || '').trim();

  const files = app.vault.getMarkdownFiles();
  const resolved = app.metadataCache.resolvedLinks || {};

  const nodes = new Map(); // path -> node
  for (const f of files) {
    let tier;
    if (isArchive(f.path)) tier = 'archive';
    else if (isCore(f.path)) tier = 'core';
    else if (isHub(f.path)) tier = 'hub';
    else {
      const g = groupOf(f.path);
      if (g) tier = 'g:' + g;
      else if (autoGroups && f.path.includes('/')) tier = 'g:' + f.path.split('/')[0];
      else tier = 'other';
    }
    nodes.set(f.path, {
      path: f.path, tier, label: prettify(f.path), seed: hash32(f.path),
      dir: f.path.lastIndexOf('/') < 0 ? '' : f.path.slice(0, f.path.lastIndexOf('/')),
      bytes: (f.stat && f.stat.size) || 0,
      wdeg: 0, adj: new Map(), // path -> weight
      parent: null, children: [],
      orbitR: 0, omega: 0, phase: 0, theta: 0, x: 0, y: 0, drawR: 3,
      z0: 0, pf: 1, depth: 0, // tilted-view layer offset + projected size/order
      ox: 0, oy: 0, vx: 0, vy: 0, // grab-offset + spring velocity (world units)
      nx: 0, ny: 0, fx: 0, fy: 0, // natural position + coupling force accumulators
      isAnchor: false,
    });
  }

  // cap folder groups: keep the MAX_GROUPS largest, everything else -> misc
  const groupCounts = new Map();
  for (const n of nodes.values()) {
    if (n.tier.startsWith('g:')) groupCounts.set(n.tier, (groupCounts.get(n.tier) || 0) + 1);
  }
  const keptGroups = [...groupCounts.entries()].sort((a, b) => b[1] - a[1])
    .slice(0, MAX_GROUPS).map(([k]) => k);
  const keptSet = new Set(keptGroups);
  for (const n of nodes.values()) {
    if (n.tier.startsWith('g:') && !keptSet.has(n.tier)) n.tier = 'other';
  }
  // stable palette assignment: sorted group keys -> palette order
  const groupColors = new Map();
  [...keptGroups].sort().forEach((k, i) => groupColors.set(k, GROUP_PALETTE[i % GROUP_PALETTE.length]));

  // undirected weighted adjacency from resolved links
  const edges = [];
  for (const src in resolved) {
    const a = nodes.get(src);
    if (!a) continue;
    for (const dst in resolved[src]) {
      const b = nodes.get(dst);
      if (!b || src === dst) continue;
      const w = resolved[src][dst];
      a.adj.set(dst, (a.adj.get(dst) || 0) + w);
      b.adj.set(src, (b.adj.get(src) || 0) + w);
    }
  }
  const seenPair = new Set();
  for (const n of nodes.values()) {
    for (const [other, w] of n.adj) {
      const key = n.path < other ? n.path + ' ' + other : other + ' ' + n.path;
      if (seenPair.has(key)) continue;
      seenPair.add(key);
      edges.push({ a: n.path, b: other, w });
    }
    n.wdeg = [...n.adj.values()].reduce((s, v) => s + v, 0);
  }

  const weightTo = (n, m2) => (n.adj.get(m2.path) || 0);
  const bestParent = (n, candidates) => {
    let best = null, bw = 0;
    for (const c of candidates) { const w = weightTo(n, c); if (w > bw) { bw = w; best = c; } }
    return { best, bw };
  };
  const adopt = (child, parent) => { child.parent = parent; parent.children.push(child); };
  const setOrbit = (n, r, K, phase) => {
    n.orbitR = r; // base radius; the view scales it live by gravity
    const vary = 0.9 + 0.2 * rand01(n.seed ^ 0xA5A5);
    n.omega = (K / Math.pow(Math.max(r, 8), 1.5)) * vary;
    n.phase = phase;
    n.theta = phase; // advanced incrementally each frame
  };

  // --- folder nodes (optional): one node per folder holding notes, nested like
  //     the folder tree. Created BEFORE the core is chosen so a core folder can
  //     take the center; placed further below.
  const showFolders = settings.showFolders !== false;
  const folderNodes = new Map(); // folder path -> node
  const folderOf = (path) => { const i = path.lastIndexOf('/'); return i < 0 ? '' : path.slice(0, i); };
  if (showFolders) {
    for (const f of files) {
      if (isArchive(f.path)) continue;
      let d = folderOf(f.path);
      while (d && !folderNodes.has(d)) {
        const base = d.split('/').pop();
        const fnode = {
          path: ' folder:' + d, folderPath: d, isFolder: true, tier: 'folder',
          label: base.length > 30 ? base.slice(0, 29) + '…' : base,
          seed: hash32('folder' + d), bytes: 0, wdeg: 0, adj: new Map(),
          parent: null, children: [],
          orbitR: 0, omega: 0, phase: 0, theta: 0, x: 0, y: 0, drawR: 5,
          z0: 0, pf: 1, depth: 0,
          ox: 0, oy: 0, vx: 0, vy: 0, nx: 0, ny: 0, fx: 0, fy: 0, isAnchor: false,
        };
        folderNodes.set(d, fnode);
        nodes.set(fnode.path, fnode);
        d = folderOf(d);
      }
    }
    // descendant note count drives folder size
    for (const f of files) {
      if (isArchive(f.path)) continue;
      let d = folderOf(f.path);
      while (d) { folderNodes.get(d).bytes++; d = folderOf(d); }
    }
    for (const fn of folderNodes.values()) {
      const topLevel = folderOf(fn.folderPath) === '';
      fn.coreFolder = !!settings.folderAsCore && (settings.folderCoreLevel === 'all' || topLevel);
      fn.hubFolder = !fn.coreFolder && !!settings.folderAsHub && !topLevel; // subfolders as hub notes
    }
  }
  // top-level core folders, biggest first: candidates for the center / the sun rings
  const topFolderCores = [...folderNodes.values()]
    .filter((f) => f.coreFolder && folderOf(f.folderPath) === '')
    .sort((a, b) => b.bytes - a.bytes || (a.folderPath < b.folderPath ? -1 : 1));

  // --- suns: rule-matched core notes, else auto-detect the most-linked notes
  //     (how many is a setting; 0 = none, and notes matching the exclusion
  //     patterns are never auto-promoted)
  const isExcluded = compileGlobs(settings.excludeRules);
  const ranked = [...nodes.values()].filter((n) => !n.isAnchor && !n.isFolder && n.tier !== 'archive')
    .sort((a, b) => b.wdeg - a.wdeg);
  const rankedAuto = ranked.filter((n) => !isExcluded(n.path));
  const autoCore = Math.max(0, Math.min(10, Math.round(settings.autoCoreCount === undefined ? 5 : settings.autoCoreCount)));
  const autoHub = Math.max(0, Math.min(20, Math.round(settings.autoHubCount === undefined ? 8 : settings.autoHubCount)));
  let suns = ranked.filter((n) => n.tier === 'core');
  if (suns.length === 0 && autoCore > 0) {
    suns = rankedAuto.slice(0, autoCore).filter((n) => n.wdeg > 0);
    if (suns.length === 0) suns = rankedAuto.slice(0, 1); // empty-link vault: one lonely star
    suns.forEach((n) => { n.tier = 'core'; });
  }
  // core layout: 'orbit' (core folders ride the outer ring, as before), 'center' (the
  // biggest core sits at the center like the original galaxy, the others orbit it)
  // or 'fixed' (same, but the other cores stay put instead of orbiting)
  const layout = settings.coreLayout === 'center' || settings.coreLayout === 'fixed' ? settings.coreLayout : 'orbit';
  const frozen = layout === 'fixed';
  let central;
  if (suns.length === 0) {
    if (layout !== 'orbit' && topFolderCores.length) {
      central = topFolderCores[0]; // the biggest core folder takes the center
      central.parent = null; central.orbitR = 0; central.omega = 0;
    } else {
      // no core at all: an invisible center point holds the galaxy together
      central = {
        path: ' center', tier: 'other', label: '', seed: hash32('center'),
        wdeg: 0, adj: new Map(), parent: null, children: [], isAnchor: true, isCenter: true,
        orbitR: 0, omega: 0, phase: 0, theta: 0, x: 0, y: 0, drawR: 0, z0: 0, pf: 1, depth: 0,
        ox: 0, oy: 0, vx: 0, vy: 0, nx: 0, ny: 0, fx: 0, fy: 0,
      };
      nodes.set(central.path, central);
    }
  } else {
    suns.sort((a, b) => b.wdeg - a.wdeg);
    central = suns[0];
    central.parent = null; central.orbitR = 0; central.omega = 0;
    for (let i = 1; i < suns.length; i++) {
      const ring = Math.floor((i - 1) / 4);
      const r = 115 + ring * 85 + (i % 2) * 14;
      adopt(suns[i], central);
      setOrbit(suns[i], r, SPEED_K.core, ((i - 1) % 4) * (Math.PI / 2) + ring * 0.45 + rand01(suns[i].seed) * 0.3);
      if (frozen) suns[i].omega = 0;
    }
  }
  if (layout !== 'orbit') {
    // the other top-level core folders join the sun system: rings of 5, 8, 11...
    let k = 0, cap = 5, used = 0;
    for (const f of topFolderCores) {
      if (f === central) continue;
      if (used >= cap) { k++; used = 0; cap = 5 + 3 * k; }
      adopt(f, central);
      setOrbit(f, 230 + k * 150, SPEED_K.core, (used / cap) * 2 * Math.PI + k * 0.5 + rand01(f.seed) * 0.2);
      if (frozen) f.omega = 0;
      used++;
    }
  }
  const sunSet = new Set(suns.map((s) => s.path));

  // --- hubs: rule-matched, else auto-detect the next most-linked notes
  let hubs = [...nodes.values()].filter((n) => n.tier === 'hub');
  if (hubs.length === 0) {
    hubs = rankedAuto.filter((n) => !sunSet.has(n.path) && n.wdeg >= 4).slice(0, autoHub);
    hubs.forEach((n) => { n.tier = 'hub'; });
  }
  const hubKids = new Map(); // sun path -> [{hub, w}]
  for (const h of hubs) {
    const { best, bw } = bestParent(h, suns);
    const sun = best || central;
    if (!hubKids.has(sun.path)) hubKids.set(sun.path, []);
    hubKids.get(sun.path).push({ h, w: bw });
  }
  for (const [sunPath, list] of hubKids) {
    const sun = nodes.get(sunPath);
    list.sort((x, y) => y.w - x.w);
    list.forEach(({ h }, idx) => {
      adopt(h, sun);
      setOrbit(h, 95 + 40 * idx, SPEED_K.hub, idx * GOLDEN + rand01(h.seed) * 0.5);
    });
  }
  const hubSet = new Set(hubs.map((h) => h.path));
  for (const fn of folderNodes.values()) {
    if (fn.coreFolder) sunSet.add(fn.path); // rendered like a sun (not a link-parent: suns[] is untouched)
    if (fn.hubFolder) hubSet.add(fn.path);  // rendered like a hub
  }

  // --- category anchors (invisible) for satellite clusters, on an outer ring
  //     (expand mode only; galaxy mode spreads unlinked notes into the disc)
  const anchors = new Map(); // group tier -> anchor node
  const present = mode === 'expand'
    ? (showFolders ? ['other'] : [...keptGroups, 'other']).filter((t) => [...nodes.values()].some((n) => n.tier === t && !n.isAnchor))
    : [];
  present.forEach((t, i) => {
    const a = {
      path: ' anchor:' + t, tier: t,
      label: t.startsWith('g:') ? t.slice(2).split('/').pop() : TIERS[t] ? TIERS[t].label : t,
      seed: hash32('anchor' + t),
      wdeg: 0, adj: new Map(), parent: null, children: [], isAnchor: true,
      orbitR: 0, omega: 0, phase: 0, theta: 0, x: 0, y: 0, drawR: 0,
      z0: 0, pf: 1, depth: 0,
      ox: 0, oy: 0, vx: 0, vy: 0, nx: 0, ny: 0, fx: 0, fy: 0,
    };
    adopt(a, central);
    setOrbit(a, 560 + (i % 2) * 90, SPEED_K.anchor, (i / present.length) * 2 * Math.PI + rand01(a.seed) * 0.4);
    anchors.set(t, a);
    nodes.set(a.path, a);
  });

  // --- folder placement (nodes were created earlier, before the core is chosen).
  //     Top-level folders orbit the core on an outer ring, subfolders orbit
  //     their parent folder. Notes with no link-parent (below) orbit their own
  //     folder. Tree lines are added after placement.
  if (showFolders) {
    const byParent = new Map(); // parent folder path ('' = root) -> [folder nodes]
    for (const fn of folderNodes.values()) {
      const pp = folderOf(fn.folderPath);
      if (!byParent.has(pp)) byParent.set(pp, []);
      byParent.get(pp).push(fn);
    }
    for (const [pp, list] of byParent) {
      list.sort((a, b) => (a.folderPath < b.folderPath ? -1 : 1));
      list.forEach((fn, i) => {
        if (pp === '') {
          if (fn === central || fn.parent) return; // already placed as a core (centered layout)
          adopt(fn, central);
          setOrbit(fn, (470 + (i % 3) * 85) * (settings.folderSpread || 1), SPEED_K.folder,
            (i / list.length) * 2 * Math.PI + rand01(fn.seed) * 0.4);
        } else {
          adopt(fn, folderNodes.get(pp));
          setOrbit(fn, (90 + 55 * i) * (settings.folderSpread || 1), SPEED_K.folder, i * GOLDEN + rand01(fn.seed) * 0.5);
        }
      });
    }
  }

  // --- everything else: orbit best-linked hub, else best-linked sun, else the
  //     group anchor (expand) or the spiral disc (galaxy).
  //     Links are gravity for the rank-and-file too: an ordinary note's orbit
  //     radius shrinks with its total link degree on a log scale (normalized
  //     to the vault's most-linked ordinary note), so a heavily-linked note
  //     hugs its parent while a one-link note rides the outer lanes. Degree
  //     drives it; the hash still sets the angle and jitter.
  let ordMax = 1;
  for (const n of nodes.values()) {
    if (n.isAnchor || n.isFolder || sunSet.has(n.path) || hubSet.has(n.path) || n.tier === 'archive') continue;
    if (n.wdeg > ordMax) ordMax = n.wdeg;
  }
  const degLogMax = Math.log(1 + ordMax);
  const degT = (n) => Math.log(1 + n.wdeg) / degLogMax; // 0 (no links) .. 1 (most-linked)

  const leafCount = new Map(); // parent path -> count so far (for sunflower spacing)
  const placeLeaf = (n, parent, tight) => {
    const idx = leafCount.get(parent.path) || 0;
    leafCount.set(parent.path, idx + 1);
    const grow = tight ? 8 : 11;
    const base = tight ? 42 : parent.isAnchor ? 20 : 24;
    // the sunflower ladder still spaces the crowd, but degree compresses it:
    // the most-linked notes get the innermost rungs (placement is degree-
    // sorted below) AND the whole ladder shrinks for them
    const hug = 1 - 0.85 * degT(n);
    adopt(n, parent);
    setOrbit(n, base + (grow * Math.sqrt(idx) + rand01(n.seed ^ 7) * 4) * hug, SPEED_K.leaf, idx * GOLDEN + rand01(n.seed) * 0.4);
  };

  const pending = []; // [node, parent, tight] — placed most-linked first
  for (const n of nodes.values()) {
    if (n.parent || n === central || n.isAnchor || n.isFolder) continue;
    if (n.tier === 'archive') {
      // archive override stands: rim debris regardless of links
      adopt(n, central);
      setOrbit(n, 760 + rand01(n.seed) * 90, SPEED_K.archive, rand01(n.seed ^ 99) * 2 * Math.PI);
      continue;
    }
    const asHubChild = bestParent(n, hubs);
    if (asHubChild.bw > 0) { pending.push([n, asHubChild.best, false]); continue; }
    const asSunChild = bestParent(n, suns);
    if (asSunChild.bw > 0) { pending.push([n, asSunChild.best, true]); continue; }
    const ownFolder = showFolders ? folderNodes.get(folderOf(n.path)) : null;
    if (ownFolder) {
      pending.push([n, ownFolder, false]);
    } else if (mode === 'expand') {
      pending.push([n, anchors.get(n.tier) || anchors.get('other') || central, false]);
    } else {
      // galaxy disc: denser toward the center, seeded on spiral arms; linked
      // notes (linked only sideways, not to any hub or sun) pull inward with
      // degree — the WHOLE radius scales, so a heavily-linked pile note can
      // cross the disc rim and ride the core (distance from center encodes
      // connectedness); unlinked dust keeps today's full spread
      const u = rand01(n.seed ^ 5);
      const r = (DISC_INNER + DISC_SPAN * Math.pow(u, 1.6)) * (1 - 0.8 * degT(n)); // density falls off with radius
      const nArms = Math.max(1, settings.arms || 3);
      const arm = n.seed % nArms;
      const phase = arm * (2 * Math.PI / nArms) + r * DISC_TWIST + (rand01(n.seed ^ 11) - 0.5) * 0.6;
      adopt(n, central);
      setOrbit(n, r, SPEED_K.disc, phase);
    }
  }
  // heavy notes claim the inner rungs: place each parent's brood most-linked
  // first (path as the deterministic tiebreak)
  pending.sort((p, q) => q[0].wdeg - p[0].wdeg || (p[0].path < q[0].path ? -1 : 1));
  for (const [n, parent, tight] of pending) placeLeaf(n, parent, tight);

  // --- folder tree lines: folder <-> note and folder <-> parent folder. Kept out
  //     of wdeg on purpose (structure must not change which notes are suns).
  if (showFolders) {
    const link = (fn, other) => {
      fn.adj.set(other.path, 1); other.adj.set(fn.path, 1);
      edges.push({ a: fn.path, b: other.path, w: 1, folder: true });
    };
    for (const f of files) {
      const fn = folderNodes.get(folderOf(f.path));
      const n = nodes.get(f.path);
      if (fn && n && !isArchive(f.path)) link(fn, n);
    }
    for (const fn of folderNodes.values()) {
      const pn = folderNodes.get(folderOf(fn.folderPath));
      if (pn) link(pn, fn);
    }
  }

  // --- draw radii: content-sized within strict tier bands. A fat note can
  //     never outgrow the tier above it (hierarchy beats content). Sizes are
  //     RANK-normalized within each tier: smallest file -> band min, largest
  //     -> band max, so every tier shows its full visual spread.
  const bandOf = (n) => {
    if (n.isFolder) return n.coreFolder ? 'coreFolder' : n.hubFolder ? 'hubFolder' : 'folder';
    if (sunSet.has(n.path)) return 'sun';
    if (hubSet.has(n.path)) return 'hub';
    if (n.tier === 'archive') return 'archive';
    return 'note';
  };
  const BANDS = { sun: [12, 26], coreFolder: [9, 18], hubFolder: [5.5, 11], hub: [5.5, 11], folder: [5.5, 9], note: [1.6, 5.0], archive: [1.0, 2.2] };
  const groups = { sun: [], coreFolder: [], hubFolder: [], hub: [], folder: [], note: [], archive: [] };
  for (const n of nodes.values()) {
    if (n.isAnchor) { n.drawR = 0; continue; }
    groups[bandOf(n)].push(n);
  }
  for (const key of Object.keys(groups)) {
    const g = groups[key].sort((a, b) => a.bytes - b.bytes);
    const [lo, hi] = BANDS[key];
    const zb = TILT.Z_BAND[key];
    g.forEach((n, i) => {
      const f = g.length > 1 ? i / (g.length - 1) : 0.7;
      n.drawR = lo + (hi - lo) * f;
      // stable tilted-view layer: two hash draws -> triangular spread biased
      // toward the mid-plane, so each tier reads as a soft band, not a slab
      n.z0 = zb * (rand01(n.seed ^ 0x51AB) + rand01(n.seed ^ 0x2E7F) - 1);
    });
  }

  // --- physics precompute: per-node mass (by tier) and total stiffness
  //     (home spring + every coupling spring touching the node), so the view
  //     can hold one designed damping ratio across the whole galaxy.
  for (const n of nodes.values()) {
    n.mass = n.isAnchor ? 1 : (PHYS.MASS[bandOf(n)] || 1);
    n.kTotal = PHYS.K_HOME;
  }
  for (const e of edges) {
    e.k = PHYS.K_LINK * Math.min(1, e.w / 2);
    const a = nodes.get(e.a), b = nodes.get(e.b);
    if (a) a.kTotal += e.k;
    if (b) b.kTotal += e.k;
  }

  // the corona-tier bodies double as the planets-view light sources.
  // Luminosity is sqrt(size), baked here so the render loop stays sqrt-free:
  // strong enough that a sun outweighs a hub at equal distance (~1.5-2.2x),
  // weak enough that a planet near its own hub faces THAT hub — size^2 let
  // the core drown out every hub and whole clusters faced the center.
  const folderLights = [...nodes.values()].filter((n) => n.coreFolder || n.hubFolder)
    .sort((a, b) => b.bytes - a.bytes).slice(0, 24); // cap: every planet sums over every light each frame
  const lights = [...suns, ...hubs, ...folderLights];
  for (const l of lights) l.lum = Math.sqrt(l.drawR);

  // gravity is applied LIVE by the view each frame (r/g, omega*g^1.5), so the
  // slider feels analog instead of rebuilding to snapped positions.
  return { nodes, edges, central, suns, sunSet, hubSet, groupColors, lights };
}

/* ------------------------------------------------------------------- view */

class GalaxyView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.model = null;
    this.raf = 0;
    this.T = 0;               // accumulated sim time
    this.lastTs = 0;
    this.timeScale = 1;
    this.paused = false;
    this.linkMode = 'auto';   // resolved to 'all' | 'hover' at build
    this.gLive = this.settings.gravity; // eased toward the slider each frame
    this._nodeDrag = null;
    this.cam = { scale: 0.5, offX: 0, offY: 0 };
    this.tiltA = TILT.ANGLES[this.settings.tilt] || 0; // eased camera pitch (rad)
    this.spinA = 0;   // idle-drift yaw (tilted views only)
    this.spinVel = 0; // eased toward SPIN_RATE when hands-off
    this.lastInput = 0;
    this.pj = null;   // current frame's projection trig (null = flat)
    this.order = [];  // painter's-order scratch list for the tilted view
    this.hover = null;
    this.hoverSet = null;
    this.dash = 0;
    this.stars = null;
    this.glowCache = new Map();
    this.coronaCache = new Map(); // corona + planet sprites, baked once per color
    this.planetCache = new Map();
    this._resolvedOnce = false;
    this._drag = null;
  }

  get settings() { return this.plugin.settings; }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Vault Galaxy'; }
  getIcon() { return 'orbit'; }

  saveSettings() { this.plugin.saveSettings(); }

  // color of one node: folders and their notes honour the per-folder override
  nodeColor(n) {
    if (n.isFolder) {
      const ov = folderOverride(this.settings, n.folderPath);
      if (ov) return ov;
      if (this.settings.colors.folder) return this.settings.colors.folder;
      return n.coreFolder ? TIERS.core.color : n.hubFolder ? TIERS.hub.color : TIERS.folder.color;
    }
    if (n.dir && n.tier !== 'core' && n.tier !== 'hub' && n.tier !== 'archive') {
      const ov = folderOverride(this.settings, n.dir);
      if (ov) return ov;
    }
    return this.colorOf(n.tier);
  }

  colorOf(tier) {
    const s = this.settings.colors[tier];
    if (s) return s;
    if (TIERS[tier]) return TIERS[tier].color;
    return (this.model && this.model.groupColors.get(tier)) || '#93a4b8';
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('vault-galaxy-root');

    this.canvas = root.createEl('canvas', { cls: 'vg-canvas' });
    this.ctx = this.canvas.getContext('2d');

    const controls = root.createDiv({ cls: 'vg-controls' });
    this.btnMode = controls.createEl('button', { text: this.settings.mode });
    this.btnTilt = controls.createEl('button', { text: this.settings.tilt });
    this.btnPause = controls.createEl('button', { text: '⏸' });
    this.btnSpeed = controls.createEl('button', { text: '1×' });
    this.btnLinks = controls.createEl('button', { text: 'links' });
    this.btnFit = controls.createEl('button', { text: '⤢ fit' });
    this.btnRebuild = controls.createEl('button', { text: '↻' });
    this.btnGear = controls.createEl('button', { text: '⚙' });
    this.statusEl = root.createDiv({ cls: 'vg-status' });

    this.registerDomEvent(this.btnMode, 'click', () => {
      this.settings.mode = this.settings.mode === 'galaxy' ? 'expand' : 'galaxy';
      this.saveSettings();
      this.btnMode.setText(this.settings.mode);
      this.build();
    });
    this.registerDomEvent(this.btnTilt, 'click', () => {
      // camera-only cycle (flat -> tilt -> steep): the frame loop tweens the
      // pitch, no rebuild needed
      const next = { flat: 'tilt', tilt: 'steep', steep: 'flat' };
      this.settings.tilt = next[this.settings.tilt] || 'flat';
      this.saveSettings();
      this.btnTilt.setText(this.settings.tilt);
    });
    this.registerDomEvent(this.btnPause, 'click', () => {
      this.paused = !this.paused;
      this.btnPause.setText(this.paused ? '▶' : '⏸');
    });
    this.registerDomEvent(this.btnSpeed, 'click', () => {
      const s = this.settings.speed;
      this.settings.speed = s < 1 ? 1 : s < 2 ? 2 : 0.5;
      this.saveSettings();
      this.syncSpeedUI();
    });
    this.registerDomEvent(this.btnLinks, 'click', () => {
      this.linkMode = this.linkMode === 'all' ? 'hover' : 'all';
      this.btnLinks.setText('links: ' + this.linkMode);
    });
    this.registerDomEvent(this.btnFit, 'click', () => this.fitView());
    this.registerDomEvent(this.btnRebuild, 'click', () => { this.build(); new Notice('Galaxy rebuilt'); });
    this.registerDomEvent(this.btnGear, 'click', () => {
      const wasOpen = this.panelEl.classList.contains('vg-open');
      this.buildPanel(this.contentEl); // re-read settings (they may have changed in the settings tab)
      if (!wasOpen) this.panelEl.classList.add('vg-open');
    });

    this.registerDomEvent(this.canvas, 'wheel', (e) => this.onWheel(e), { passive: false });
    this.registerDomEvent(this.canvas, 'pointerdown', (e) => this.onPointerDown(e));
    this.registerDomEvent(this.canvas, 'pointermove', (e) => this.onPointerMove(e));
    this.registerDomEvent(this.canvas, 'pointerup', (e) => this.onPointerUp(e));
    this.registerDomEvent(this.canvas, 'pointerleave', () => {
      this._nodeDrag = null; // released off-canvas: spring home
      this.hover = null; this.hoverSet = null;
    });

    // if the metadata cache finishes resolving after we open (cold app start),
    // rebuild once so the galaxy isn't sparse
    this.registerEvent(this.app.metadataCache.on('resolved', () => {
      if (!this._resolvedOnce) { this._resolvedOnce = true; this.build(); }
    }));

    this.syncSpeedUI();
    this.build();
    this.buildPanel(root);
    this.resizeCanvas();
    this.fitView();
    // re-measure whenever the pane's size actually changes (covers late layout,
    // sidebar drags, window resizes)
    this._ro = new ResizeObserver(() => {
      this.resizeCanvas();
      if (!this._userMoved) this.fitView();
    });
    this._ro.observe(this.contentEl);
    this.lastTs = performance.now();
    const loop = (ts) => { this.frame(ts); this.raf = requestAnimationFrame(loop); };
    this.raf = requestAnimationFrame(loop);
  }

  async onClose() {
    cancelAnimationFrame(this.raf);
    if (this._ro) this._ro.disconnect();
  }

  onResize() {
    this.resizeCanvas();
  }

  syncSpeedUI() {
    this.btnSpeed.setText((Math.round(this.settings.speed * 10) / 10) + '×');
    if (this._speedSlider) this._speedSlider.value = this.settings.speed;
  }

  buildPanel(root) {
    if (this.panelEl) this.panelEl.remove();
    const panel = root.createDiv({ cls: 'vg-panel' });
    this.panelEl = panel;

    this._secOpen = this._secOpen || { Folders: true, 'Core nodes': true };
    let body = panel; // rows are added to the current section's body
    const section = (title) => {
      const open = !!this._secOpen[title];
      const hd = panel.createEl('div', { cls: 'vg-sec vg-sec-toggle', text: (open ? '▾ ' : '▸ ') + title });
      body = panel.createDiv({ cls: 'vg-secbody' });
      body.style.display = open ? '' : 'none';
      const bodyRef = body;
      this.registerDomEvent(hd, 'click', () => {
        const nowOpen = bodyRef.style.display === 'none';
        bodyRef.style.display = nowOpen ? '' : 'none';
        hd.setText((nowOpen ? '▾ ' : '▸ ') + title);
        this._secOpen[title] = nowOpen;
      });
    };
    const slider = (label, min, max, step, get, onInput, rebuilds) => {
      const row = body.createDiv({ cls: 'vg-row' });
      row.createEl('span', { text: label });
      const inp = row.createEl('input');
      inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step; inp.value = get();
      this.registerDomEvent(inp, 'input', () => {
        onInput(parseFloat(inp.value));
        this.saveSettings();
        if (rebuilds) this.build();
      });
      return inp;
    };
    const s = this.settings;

    section('Folders');
    {
      const row = body.createDiv({ cls: 'vg-row' });
      row.createEl('span', { text: 'folders as nodes' });
      const inp = row.createEl('input');
      inp.type = 'checkbox'; inp.checked = s.showFolders !== false;
      this.registerDomEvent(inp, 'change', () => {
        s.showFolders = inp.checked; this.saveSettings(); this.build();
      });
      this._foldersCheck = inp; // kept in sync by the settings tab
    }
    {
      const row = body.createDiv({ cls: 'vg-row' });
      row.createEl('span', { text: 'folders as core' });
      const inp = row.createEl('input');
      inp.type = 'checkbox'; inp.checked = !!s.folderAsCore;
      this.registerDomEvent(inp, 'change', () => {
        s.folderAsCore = inp.checked; this.saveSettings(); this.build();
      });
    }
    {
      const row = body.createDiv({ cls: 'vg-row' });
      row.createEl('span', { text: 'subfolders as hubs' });
      const inp = row.createEl('input');
      inp.type = 'checkbox'; inp.checked = !!s.folderAsHub;
      this.registerDomEvent(inp, 'change', () => {
        s.folderAsHub = inp.checked; this.saveSettings(); this.build();
      });
    }
    slider('folder size', 0.3, 3, 0.05, () => (s.folderSize === undefined ? 1 : s.folderSize), (v) => { s.folderSize = v; }, false);
    slider('folder names threshold', 0, 20, 0.1, () => s.folderLabelZoom || 0, (v) => { s.folderLabelZoom = v; }, false);

    section('Core nodes');
    {
      const row = body.createDiv({ cls: 'vg-row' });
      row.createEl('span', { text: 'position' });
      const sel = row.createEl('select');
      for (const [val, name] of [['orbit', 'Orbiting'], ['center', 'Centered'], ['fixed', 'Centered, fixed']]) {
        const opt = sel.createEl('option', { text: name });
        opt.value = val;
      }
      sel.value = s.coreLayout || 'orbit';
      this.registerDomEvent(sel, 'change', () => { s.coreLayout = sel.value; this.saveSettings(); this.build(); });
    }
    slider('auto core notes', 0, 10, 1, () => (s.autoCoreCount === undefined ? 5 : s.autoCoreCount), (v) => { s.autoCoreCount = v; }, true);
    slider('auto hub notes', 0, 20, 1, () => (s.autoHubCount === undefined ? 8 : s.autoHubCount), (v) => { s.autoHubCount = v; }, true);
    slider('core brightness', 0, 2.5, 0.05, () => (s.coreBrightness === undefined ? 1 : s.coreBrightness), (v) => { s.coreBrightness = v; }, false);
    {
      const row = body.createDiv({ cls: 'vg-row' });
      row.createEl('span', { text: 'core center color' });
      const inp = row.createEl('input');
      inp.type = 'color'; inp.value = s.coreCenterColor || DEFAULT_SETTINGS.coreCenterColor;
      this.registerDomEvent(inp, 'input', () => { s.coreCenterColor = inp.value; this.saveSettings(); });
    }

    section('Forces');
    slider('gravity', 0.5, 1.8, 0.01, () => s.gravity, (v) => { s.gravity = v; }, false);
    slider('bounciness', 0, 1, 0.05, () => (s.bounciness === undefined ? 0.6 : s.bounciness), (v) => { s.bounciness = v; }, false);
    this._speedSlider = slider('speed', 0, 3, 0.1, () => s.speed, (v) => { s.speed = v; this.syncSpeedUI(); }, false);
    slider('spiral arms', 1, 6, 1, () => s.arms, (v) => { s.arms = v; }, true);

    section('Display');
    {
      const row = body.createDiv({ cls: 'vg-row' });
      row.createEl('span', { text: 'node style' });
      const sel = row.createEl('select');
      for (const [val, name] of [['disc', 'Classic'], ['planet', 'Planets']]) {
        const opt = sel.createEl('option', { text: name });
        opt.value = val;
      }
      sel.value = s.nodeStyle || 'disc';
      this.registerDomEvent(sel, 'change', () => {
        s.nodeStyle = sel.value;
        this.saveSettings();
      });
      this._styleSelect = sel; // kept in sync by the settings-tab dropdown
    }
    {
      const row = body.createDiv({ cls: 'vg-row' });
      row.createEl('span', { text: 'core names always on' });
      const inp = row.createEl('input');
      inp.type = 'checkbox'; inp.checked = s.sunLabels;
      this.registerDomEvent(inp, 'change', () => { s.sunLabels = inp.checked; this.saveSettings(); });
    }
    slider('node size', 0.5, 2.2, 0.05, () => s.nodeSize, (v) => { s.nodeSize = v; }, false);
    slider('label threshold', 0.3, 3, 0.05, () => s.labelZoom, (v) => { s.labelZoom = v; }, false);
    slider('glow', 0, 2, 0.05, () => s.glow, (v) => { s.glow = v; }, false);
    {
      const row = body.createDiv({ cls: 'vg-row' });
      row.createEl('span', { text: 'corona' });
      const inp = row.createEl('input');
      inp.type = 'checkbox'; inp.checked = !!s.corona;
      this.registerDomEvent(inp, 'change', () => { s.corona = inp.checked; this.saveSettings(); });
      this._coronaCheck = inp; // kept in sync by the settings tab
    }
    this._coronaSlider = slider('corona strength', 0.2, 2.5, 0.05,
      () => (s.coronaStrength === undefined ? 1 : s.coronaStrength), (v) => { s.coronaStrength = v; }, false);
    slider('link thickness', 0.4, 3, 0.1, () => s.linkWidth, (v) => { s.linkWidth = v; }, false);
    slider('link brightness', 0.2, 3, 0.1, () => s.linkAlpha, (v) => { s.linkAlpha = v; }, false);

    section('Colors');
    const colorKeys = ['core', 'hub',
      ...(this.model ? [...this.model.groupColors.keys()].sort() : []),
      'other', 'archive', 'folder'];
    for (const tier of colorKeys) {
      const row = body.createDiv({ cls: 'vg-row' });
      row.createEl('span', {
        text: tier.startsWith('g:') ? tier.slice(2).split('/').pop() : TIERS[tier].label,
      });
      const inp = row.createEl('input');
      inp.type = 'color'; inp.value = this.colorOf(tier);
      this.registerDomEvent(inp, 'input', () => {
        s.colors[tier] = inp.value;
        this.saveSettings();
      });
    }

    section('Folder colors');
    for (const d of listVaultFolders(this.app)) {
      const depth = d.split('/').length - 1;
      const row = body.createDiv({ cls: 'vg-row' });
      const lab = row.createEl('span', { text: d.split('/').pop() });
      lab.style.paddingLeft = (depth * 10) + 'px';
      lab.title = d;
      const inp = row.createEl('input');
      inp.type = 'color';
      inp.value = folderOverride(s, d) || this.colorOf('folder');
      this.registerDomEvent(inp, 'input', () => {
        s.folderColors = s.folderColors || {};
        s.folderColors[d] = inp.value;
        this.saveSettings();
      });
      const x = row.createEl('button', { text: '↺' });
      x.title = 'remove this folder\'s color';
      this.registerDomEvent(x, 'click', () => {
        if (s.folderColors) delete s.folderColors[d];
        this.saveSettings();
        inp.value = folderOverride(s, d) || this.colorOf('folder');
      });
    }

    const reset = panel.createEl('button', { cls: 'vg-reset', text: 'reset to defaults' });
    this.registerDomEvent(reset, 'click', () => {
      const keepRules = {
        coreRules: s.coreRules, hubRules: s.hubRules,
        archiveFolders: s.archiveFolders, folderGroups: s.folderGroups,
        excludeRules: s.excludeRules, autoCoreCount: s.autoCoreCount, autoHubCount: s.autoHubCount,
        folderColors: s.folderColors,
      };
      this.plugin.settings = { ...DEFAULT_SETTINGS, colors: {}, ...keepRules };
      this.saveSettings();
      this.buildPanel(root);
      this.panelEl.classList.add('vg-open');
      this.syncSpeedUI();
      this.btnMode.setText(this.settings.mode);
      this.btnTilt.setText(this.settings.tilt);
      this.build();
    });
  }

  build() {
    try {
      this.model = buildModel(this.app, this.settings);
      this.order = [...this.model.nodes.values()];
      if (this.linkMode === 'auto' || this.linkMode === 'all' || this.linkMode === 'hover') {
        const auto = this.model.edges.filter((e) => !e.folder).length > 2600 ? 'hover' : 'all';
        if (this.linkMode === 'auto') this.linkMode = auto;
        this.btnLinks.setText('links: ' + this.linkMode);
      }
      const nNotes = [...this.model.nodes.values()].filter((n) => !n.isAnchor && !n.isFolder).length;
      const nFolders = [...this.model.nodes.values()].filter((n) => n.isFolder).length;
      const nLinks = this.model.edges.filter((e) => !e.folder).length;
      this.statusEl.setText(`${this.settings.mode} · ${nNotes} notes · ${nFolders ? nFolders + ' folders · ' : ''}${nLinks} links · hover to inspect · click to open · drag to disturb`);
      if (!this.stars) this.makeStars();
    } catch (e) {
      console.error('[vault-galaxy] build failed', e);
      new Notice('Vault Galaxy: build failed — see console');
    }
  }

  makeStars() {
    this.stars = [];
    for (let i = 0; i < 420; i++) {
      const s = hash32('star' + i);
      this.stars.push({
        x: (rand01(s) - 0.5) * 3400,
        y: (rand01(s ^ 1) - 0.5) * 3400,
        r: 0.4 + rand01(s ^ 2) * 1.3,
        tw: 0.5 + rand01(s ^ 3) * 2,
        ph: rand01(s ^ 4) * 6.28,
      });
    }
  }

  resizeCanvas() {
    const rect = this.contentEl.getBoundingClientRect();
    this.w = Math.max(50, rect.width);
    this.h = Math.max(50, rect.height);
    const dpr = window.devicePixelRatio || 1;
    this.dpr = dpr;
    this.canvas.width = this.w * dpr;
    this.canvas.height = this.h * dpr;
    this.canvas.style.width = this.w + 'px';
    this.canvas.style.height = this.h + 'px';
  }

  fitView() {
    const world = 930; // archive rim + margin
    this.cam.scale = Math.max(0.08, (Math.min(this.w, this.h) / (2 * world)) * 0.95);
    this.cam.offX = this.w / 2;
    this.cam.offY = this.h / 2;
  }

  /* ---- interaction */

  onWheel(e) {
    e.preventDefault();
    this._userMoved = true;
    this.lastInput = performance.now();
    const f = Math.exp(-e.deltaY * 0.0012);
    const ns = Math.min(6, Math.max(0.08, this.cam.scale * f));
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    // zoom to cursor
    this.cam.offX = mx - ((mx - this.cam.offX) / this.cam.scale) * ns;
    this.cam.offY = my - ((my - this.cam.offY) / this.cam.scale) * ns;
    this.cam.scale = ns;
  }

  onPointerDown(e) {
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    this.lastInput = performance.now();
    this.updateHover(mx, my);
    if (this.hover && !this.hover.isAnchor) {
      // grab the node: drag it anywhere, throw it, gravity reels it home.
      // Pointer positions are cast onto the node's own plane layer, so the
      // identical world-space grab math drives both the flat and tilted views.
      const n = this.hover;
      const w = this.unproject(mx, my, n.z0);
      this._nodeDrag = {
        node: n, x: e.clientX, y: e.clientY, ox0: n.ox, oy0: n.oy, moved: false,
        wx: w.x, wy: w.y, lastWX: w.x, lastWY: w.y, lastT: performance.now(), tvx: 0, tvy: 0,
      };
      this._excited = true; // wake the coupled displacement field
      this.canvas.style.cursor = 'grabbing';
    } else {
      this._drag = { x: e.clientX, y: e.clientY, offX: this.cam.offX, offY: this.cam.offY, moved: false };
    }
    try { this.canvas.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
  }

  onPointerMove(e) {
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    this.lastInput = performance.now();
    if (this._nodeDrag) {
      const nd = this._nodeDrag;
      if (Math.abs(e.clientX - nd.x) + Math.abs(e.clientY - nd.y) > 5) nd.moved = true;
      const w = this.unproject(mx, my, nd.node.z0);
      nd.node.ox = nd.ox0 + (w.x - nd.wx);
      nd.node.oy = nd.oy0 + (w.y - nd.wy);
      nd.node.vx = nd.node.vy = 0; // held = kinematic
      // track flick velocity (world units/s, EMA over ~40ms) for throw-on-release
      const now = performance.now();
      const dtm = now - nd.lastT;
      if (dtm > 0) {
        const k = 1 - Math.exp(-dtm / 40);
        nd.tvx = nd.tvx * (1 - k) + ((w.x - nd.lastWX) / (dtm / 1000)) * k;
        nd.tvy = nd.tvy * (1 - k) + ((w.y - nd.lastWY) / (dtm / 1000)) * k;
        nd.lastWX = w.x; nd.lastWY = w.y; nd.lastT = now;
      }
      return;
    }
    if (this._drag) {
      const dx = e.clientX - this._drag.x, dy = e.clientY - this._drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 5) this._drag.moved = true;
      if (this._drag.moved) {
        this._userMoved = true;
        this.cam.offX = this._drag.offX + dx;
        this.cam.offY = this._drag.offY + dy;
        return;
      }
    }
    this.updateHover(mx, my);
  }

  onPointerUp(e) {
    if (this._nodeDrag) {
      const nd = this._nodeDrag;
      this._nodeDrag = null; // spring takes over from here
      this.canvas.style.cursor = 'pointer';
      if (!nd.moved && !nd.node.isAnchor && !nd.node.isFolder) {
        const file = this.app.vault.getAbstractFileByPath(nd.node.path);
        if (file instanceof TFile) this.app.workspace.getLeaf('tab').openFile(file);
      } else if (nd.moved) {
        // throw: carry the flick velocity into the release (stale flick = plain drop)
        const clamp = (v) => Math.max(-PHYS.V_CAP, Math.min(PHYS.V_CAP, v));
        const stale = performance.now() - nd.lastT > 100;
        nd.node.vx = stale ? 0 : clamp(nd.tvx);
        nd.node.vy = stale ? 0 : clamp(nd.tvy);
      }
      return;
    }
    this._drag = null;
  }

  // cast a screen point back through the camera onto the simulation plane
  // (the layer z of the node being grabbed). The flat view reduces to plain
  // scale/offset, so one path serves both modes and drags stay in world units.
  unproject(mx, my, z0) {
    const px = (mx - this.cam.offX) / this.cam.scale;
    const py = (my - this.cam.offY) / this.cam.scale;
    if (!this.pj) return { x: px, y: py };
    const { sinT, cosT, sinS, cosS, zs } = this.pj;
    const z = z0 * zs;
    const F = TILT.FOCAL;
    // invert py = (yr*cosT - z*sinT) * F / (F - yr*sinT - z*cosT) for yr, then
    // recover xr from the same perspective factor. Clamped well inside the
    // horizon so a wild pointer can never flip the ray behind the camera.
    let yr = (py * (F - z * cosT) + F * z * sinT) / (F * cosT + py * sinT);
    if (!isFinite(yr)) yr = py;
    yr = Math.max(-2600, Math.min(2600, yr));
    const p = F / (F - yr * sinT - z * cosT);
    const xr = px / p;
    return { x: xr * cosS + yr * sinS, y: yr * cosS - xr * sinS };
  }

  updateHover(mx, my) {
    if (!this.model) return;
    let best = null, bd = 1e9;
    for (const n of this.model.nodes.values()) {
      if (n.isAnchor) continue;
      const dx = n.sx - mx, dy = n.sy - my;
      const d = Math.hypot(dx, dy);
      const hitR = Math.max(7, n.drawR * this.settings.nodeSize * (n.isFolder ? (this.settings.folderSize || 1) : 1) * this.cam.scale * n.pf + 4);
      if (d < hitR && d < bd) { bd = d; best = n; }
    }
    if (best !== this.hover) {
      this.hover = best;
      if (best) {
        this.hoverSet = new Set([best.path]);
        for (const p of best.adj.keys()) this.hoverSet.add(p);
      } else this.hoverSet = null;
      this.canvas.style.cursor = best ? 'pointer' : 'default';
    }
  }

  /* ---- rendering */

  glow(color, size) {
    const key = color + '|' + Math.round(size);
    let c = this.glowCache.get(key);
    if (!c) {
      const s = Math.max(4, Math.round(size));
      c = document.createElement('canvas');
      c.width = c.height = s * 2;
      const g = c.getContext('2d');
      const grad = g.createRadialGradient(s, s, 0, s, s, s);
      grad.addColorStop(0, color + 'cc');
      grad.addColorStop(0.35, color + '55');
      grad.addColorStop(1, color + '00');
      g.fillStyle = grad;
      g.fillRect(0, 0, s * 2, s * 2);
      if (this.glowCache.size > 300) this.glowCache.clear();
      this.glowCache.set(key, c);
    }
    return c;
  }

  // corona for the big bodies: layered bloom in the body's own color plus
  // ray spikes — broad soft drama on the suns; hotter, denser flare on the
  // hubs so the "lesser sun" reads at their much smaller on-screen size.
  // Drawn additively in the glow pass in place of the standard glow.
  coronaSprite(color, kind) {
    const key = color + '|' + kind;
    let c = this.coronaCache.get(key);
    if (!c) {
      const s = 128;
      const sun = kind === 'sun';
      c = document.createElement('canvas');
      c.width = c.height = s * 2;
      const g = c.getContext('2d');
      const grad = g.createRadialGradient(s, s, 0, s, s, s);
      // hubs are "lesser suns": their bodies are far smaller, so a scaled-down
      // copy of the sun sprite just melts into the standard glow it replaces.
      // Instead the hub sprite runs hotter — brighter bloom stops end to end,
      // with full-length, much thicker, whiter spikes so the cross-flare
      // still reads at the small sizes hubs render at.
      grad.addColorStop(0, color + (sun ? 'd9' : 'ee'));
      grad.addColorStop(0.2, color + (sun ? '66' : '88'));
      grad.addColorStop(0.5, color + (sun ? '1f' : '2e'));
      grad.addColorStop(1, color + '00');
      g.fillStyle = grad;
      g.beginPath(); g.arc(s, s, s, 0, 6.2832); g.fill();
      for (const [dx, dy, f] of [[1, 0, 1], [-1, 0, 1], [0, 1, 0.8], [0, -1, 0.8]]) {
        const len = s * f;
        const sp = g.createLinearGradient(s, s, s + dx * len, s + dy * len);
        sp.addColorStop(0, 'rgba(255,255,255,' + (sun ? 0.4 : 0.5) + ')');
        sp.addColorStop(0.25, color + (sun ? '33' : '3d'));
        sp.addColorStop(1, color + '00');
        g.strokeStyle = sp;
        // hub spikes are proportionally much thicker and whiter: the hub
        // sprite renders at a fraction of the sun's on-screen size, so
        // sun-ratio spikes would downscale to under a pixel and vanish
        g.lineWidth = s * (sun ? 0.035 : 0.09);
        g.beginPath(); g.moveTo(s, s); g.lineTo(s + dx * len, s + dy * len); g.stroke();
      }
      this.coronaCache.set(key, c);
    }
    return c;
  }

  // planets-view leaf: a lit sphere baked once per color and contrast level —
  // Lambert falloff with a soft terminator, color-tinted atmosphere on the
  // lit limb, night side sinking into deep blue. Each level bakes a more
  // head-on light and higher ambient (crisp crescent -> near-ambient); the
  // draw call picks levels by light directionality and rotates the sprite so
  // the lit side faces the blended light direction.
  planetSprite(color, level) {
    const key = color + '|' + level;
    let c = this.planetCache.get(key);
    if (!c) {
      const { L, amb, t0, t1, night } = PLANET_LEVELS[level];
      const r = 56, halo = 1.25, R = Math.ceil(r * halo) + 1, size = R * 2;
      c = document.createElement('canvas');
      c.width = c.height = size;
      const g = c.getContext('2d');
      const img = g.createImageData(size, size);
      const px = img.data;
      const nCol = parseInt(color.slice(1), 16);
      const ar = (nCol >> 16) & 255, ag = (nCol >> 8) & 255, ab = nCol & 255;
      const smooth = (a, b, x) => { const k = Math.max(0, Math.min(1, (x - a) / (b - a))); return k * k * (3 - 2 * k); };
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const u = (x - R + 0.5) / r, v = (y - R + 0.5) / r;
          const d = Math.hypot(u, v);
          const i = (y * size + x) * 4;
          if (d <= 1.004) {
            const nz = Math.sqrt(Math.max(0, 1 - u * u - v * v));
            const ndl = u * L[0] + v * L[1] + nz * L[2];
            const t = smooth(t0, t1, ndl); // soft terminator
            const diff = amb + (1 - amb) * Math.pow(Math.max(0, ndl), 1.15);
            const nr = ar * night + 6, ng = ag * night + 8, nb = ab * night + 18;
            let cr = nr + (ar * diff - nr) * t;
            let cg = ng + (ag * diff - ng) * t;
            let cb = nb + (ab * diff - nb) * t;
            const fres = Math.pow(1 - nz, 2.8) * (0.25 + 0.75 * t) * 0.7;
            cr += (ar + (255 - ar) * 0.35) * fres;
            cg += (ag + (255 - ag) * 0.35) * fres;
            cb += (ab + (255 - ab) * 0.35) * fres;
            px[i] = Math.min(255, cr); px[i + 1] = Math.min(255, cg); px[i + 2] = Math.min(255, cb);
            px[i + 3] = 255 * Math.max(0, Math.min(1, (1 - d) * r * 2 + 0.5));
          } else if (d < halo) {
            // atmosphere halo just outside the body, brightest on the lit edge
            const h = 1 - (d - 1) / (halo - 1);
            const lit = Math.max(0, (u * L[0]) / d);
            px[i] = ar + (255 - ar) * 0.4; px[i + 1] = ag + (255 - ag) * 0.4; px[i + 2] = ab + (255 - ab) * 0.4;
            px[i + 3] = 255 * h * h * (0.25 + 0.75 * lit) * 0.35;
          }
        }
      }
      g.putImageData(img, 0, 0);
      this.planetCache.set(key, c);
    }
    return c;
  }

  frame(ts) {
    const dt = Math.min(0.05, (ts - this.lastTs) / 1000);
    this.lastTs = ts;

    // eased time-scale: pause -> 0, hover -> slow-mo, else speed setting
    const target = this.paused ? 0 : (this.hover ? 0.15 : 1) * this.settings.speed;
    this.timeScale += (target - this.timeScale) * Math.min(1, dt * 6);
    this.T += dt * this.timeScale;
    this.dash -= dt * 26;

    // tilted-view camera: ease the pitch toward the chosen step; the idle
    // drift runs hands-off in the tilted views only and unwinds on the way
    // flat, so the 2D view always lands back pixel-exact.
    const tiltGoal = TILT.ANGLES[this.settings.tilt] || 0;
    this.tiltA += (tiltGoal - this.tiltA) * Math.min(1, dt * 3);
    if (Math.abs(this.tiltA - tiltGoal) < 0.0005) this.tiltA = tiltGoal;
    if (tiltGoal > 0) {
      const idle = this.settings.idleSpin && !this._nodeDrag && !this._drag &&
        ts - this.lastInput > TILT.SPIN_IDLE_MS;
      this.spinVel += ((idle ? TILT.SPIN_RATE : 0) - this.spinVel) * Math.min(1, dt * 2);
      this.spinA += this.spinVel * dt;
      if (this.spinA > Math.PI) this.spinA -= 2 * Math.PI; // keep the yaw wrapped
    } else if (this.spinA !== 0) {
      this.spinVel = 0;
      this.spinA *= Math.max(0, 1 - dt * 3);
      if (Math.abs(this.spinA) < 0.0005) this.spinA = 0;
    }

    const m = this.model;
    if (!m || !this.ctx) return;
    const { scale, offX, offY } = this.cam;
    const ctx = this.ctx;

    // live gravity: ease toward the slider, contract radii, speed up Kepler-style
    this.gLive += (Math.max(0.3, this.settings.gravity || 1) - this.gLive) * Math.min(1, dt * 4);
    const g15 = Math.pow(this.gLive, 1.5);
    const dtSim = dt * this.timeScale;

    // advance orbital positions, parents before children (BFS from center).
    // theta advances incrementally so gravity/speed changes never snap angles.
    // NATURAL positions (nx, ny) nest on the parent's NATURAL position —
    // displacement does NOT travel down the hierarchy; it travels along links.
    const stepNode = (n, pnx, pny) => {
      n.theta += n.omega * g15 * dtSim;
      const r = n.orbitR / this.gLive;
      n.nx = pnx + r * Math.cos(n.theta);
      n.ny = pny + r * Math.sin(n.theta);
    };
    stepNode(m.central, 0, 0); // orbitR 0 -> natural position is the origin
    const queue = [m.central];
    while (queue.length) {
      const p = queue.pop();
      for (const c of p.children) {
        stepNode(c, p.nx, p.ny);
        queue.push(c);
      }
    }

    // coupled displacement field: every node feels a home-spring back to its
    // natural orbit PLUS coupling springs along its links (stiffness ~ link
    // weight). Drag one node and its constellation is tugged toward it,
    // second-order neighbors less; release (or THROW) and the web swings —
    // pendulum overshoot, energy sloshing between neighbors — then re-rests.
    if (this._excited) {
      // bounciness -> damping ratio: 0 -> ~critically damped (dead return),
      // 1 -> zeta 0.08 (long ring). Default 0.6 -> zeta ~0.22, 4-5 swings.
      const b = this.settings.bounciness === undefined ? 0.6 : this.settings.bounciness;
      const zeta = Math.max(0.05, 0.9 * Math.pow(1 - b, 2) + 0.08);
      const total = Math.min(0.033, dt); // springs run on real time, even paused
      const steps = total > 0.02 ? 2 : 1; // sub-step big frames for stiff-node stability
      const sdt = total / steps;
      const clamp = (v, c) => (v > c ? c : v < -c ? -c : v);
      let energy = 0;
      for (let s = 0; s < steps; s++) {
        // accumulate SPRING forces only — damping is applied implicitly below,
        // outside the force cap, so friction survives even when the springs
        // saturate F_CAP (capped damping was an energy leak: violent throws
        // rang forever at high bounciness because the cap truncated friction).
        for (const n of m.nodes.values()) {
          n.fx = -PHYS.K_HOME * n.ox;
          n.fy = -PHYS.K_HOME * n.oy;
        }
        for (const e of m.edges) {
          const a = m.nodes.get(e.a), b2 = m.nodes.get(e.b);
          if (!a || !b2) continue;
          const dx = a.ox - b2.ox, dy = a.oy - b2.oy;
          if (!dx && !dy) continue;
          b2.fx += e.k * dx; b2.fy += e.k * dy;
          a.fx -= e.k * dx; a.fy -= e.k * dy;
        }
        energy = 0;
        for (const n of m.nodes.values()) {
          const held = this._nodeDrag && this._nodeDrag.node === n;
          if (!held) {
            // damping ratio applies to the HOME mode only — heavily-linked
            // nodes already dissipate by bleeding energy into their neighbors,
            // so scaling cD by kTotal double-penalized them into dead returns
            const cD = zeta * 2 * Math.sqrt(PHYS.K_HOME * n.mass);
            const damp = 1 / (1 + (cD / n.mass) * sdt); // implicit: unconditionally stable
            n.vx = clamp((n.vx + (clamp(n.fx, PHYS.F_CAP) / n.mass) * sdt) * damp, PHYS.V_CAP);
            n.vy = clamp((n.vy + (clamp(n.fy, PHYS.F_CAP) / n.mass) * sdt) * damp, PHYS.V_CAP);
            n.ox += n.vx * sdt; n.oy += n.vy * sdt;
          }
          energy += Math.abs(n.ox) + Math.abs(n.oy) + Math.abs(n.vx) + Math.abs(n.vy);
        }
      }
      if (!this._nodeDrag && energy < 8) {
        for (const n of m.nodes.values()) { n.ox = n.oy = n.vx = n.vy = 0; }
        this._excited = false;
      }
    }
    for (const n of m.nodes.values()) { n.x = n.nx + n.ox; n.y = n.ny + n.oy; }
    const proj = this.tiltA > 0 || this.spinA !== 0;
    if (!proj) {
      if (this.pj) { // just landed flat: clear the last tween frame's residue
        for (const n of m.nodes.values()) { n.pf = 1; n.depth = 0; }
        this.pj = null;
      }
      for (const n of m.nodes.values()) { n.sx = n.x * scale + offX; n.sy = n.y * scale + offY; }
    } else {
      // rotate the plane about the screen X axis with mild perspective. Trig
      // is hoisted out of the loop; per-node cost is a handful of multiplies.
      const sinT = Math.sin(this.tiltA), cosT = Math.cos(this.tiltA);
      const sinS = Math.sin(this.spinA), cosS = Math.cos(this.spinA);
      // z-offsets are fully grown by the first tilt step and hold from there
      const zs = Math.min(1, this.tiltA / TILT.ANGLES.tilt);
      this.pj = { sinT, cosT, sinS, cosS, zs };
      for (const n of m.nodes.values()) {
        const xr = n.x * cosS - n.y * sinS;
        const yr = n.x * sinS + n.y * cosS;
        const z = n.z0 * zs;
        const zc = yr * sinT + z * cosT; // camera depth (+ = toward the viewer)
        const p = TILT.FOCAL / (TILT.FOCAL - zc);
        n.pf = p;
        n.depth = zc;
        n.sx = xr * p * scale + offX;
        n.sy = (yr * cosT - z * sinT) * p * scale + offY;
      }
      // painter's order: far nodes first, near nodes drawn over them
      this.order.sort((u, v) => u.depth - v.depth);
    }

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#04050d';
    ctx.fillRect(0, 0, this.w, this.h);

    // starfield with parallax + twinkle
    ctx.fillStyle = '#c8d4ee';
    for (const s of this.stars) {
      const sx = s.x * scale * 0.35 + offX, sy = s.y * scale * 0.35 + offY;
      if (sx < -5 || sy < -5 || sx > this.w + 5 || sy > this.h + 5) continue;
      ctx.globalAlpha = 0.18 + 0.14 * Math.sin(ts / 1000 * s.tw + s.ph);
      ctx.beginPath();
      ctx.arc(sx, sy, s.r, 0, 6.2832);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    const onScreen = (n, pad) =>
      n.sx > -pad && n.sy > -pad && n.sx < this.w + pad && n.sy < this.h + pad;

    // constellation lines
    const st = this.settings;
    if (this.linkMode === 'all') {
      ctx.strokeStyle = '#6f87c9';
      ctx.lineWidth = st.linkWidth;
      for (const e of m.edges) {
        if (e.folder) continue;
        const a = m.nodes.get(e.a), b = m.nodes.get(e.b);
        if (!a || !b) continue;
        if (!onScreen(a, 60) && !onScreen(b, 60)) continue;
        const modeDim = st.mode === 'galaxy' ? 0.45 : 1; // links whisper in galaxy mode
        ctx.globalAlpha = Math.min(0.85,
          Math.min(0.16, 0.05 + e.w * 0.02) * (this.hoverSet ? 0.35 : 1) * modeDim * st.linkAlpha);
        ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    // folder tree lines: warm, separate from the blue link constellation. Drawn
    // whatever the 'links' button says — they are structure, not link noise.
    if (st.showFolders !== false) {
      ctx.lineWidth = st.linkWidth * (st.folderLineWidth === undefined ? 1 : st.folderLineWidth);
      ctx.globalAlpha = Math.min(0.9, 0.07 * st.linkAlpha * (st.folderLineAlpha === undefined ? 1 : st.folderLineAlpha) * (this.hoverSet ? 0.35 : 1));
      const buckets = new Map(); // color -> Path2D (lines take the color of their folder)
      for (const e of m.edges) {
        if (!e.folder) continue;
        const a = m.nodes.get(e.a), b = m.nodes.get(e.b);
        if (!a || !b) continue;
        if (!onScreen(a, 60) && !onScreen(b, 60)) continue;
        const col = st.folderLineColor || this.nodeColor(a);
        let path = buckets.get(col);
        if (!path) { path = new Path2D(); buckets.set(col, path); }
        path.moveTo(a.sx, a.sy); path.lineTo(b.sx, b.sy);
      }
      for (const [col, path] of buckets) { ctx.strokeStyle = col; ctx.stroke(path); }
      ctx.globalAlpha = 1;
    }
    if (this.hover) {
      // hovered constellation, lit and gently flowing
      ctx.strokeStyle = '#cfe3ff';
      ctx.lineWidth = 1.4 * st.linkWidth;
      ctx.setLineDash([5, 7]);
      ctx.lineDashOffset = this.dash;
      ctx.globalAlpha = 0.8;
      for (const [other] of this.hover.adj) {
        const b = m.nodes.get(other);
        if (!b) continue;
        ctx.beginPath(); ctx.moveTo(this.hover.sx, this.hover.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    // node style: 'disc' keeps today's look everywhere; 'planet' keeps the
    // suns and hubs classic and renders everything below them as shaded
    // planets lit by the core. The corona toggle is independent of both.
    const ns = st.nodeStyle || 'disc';
    const coronaOn = !!st.corona;
    const coronaCs = st.coronaStrength === undefined ? 1 : st.coronaStrength;
    // core brightness: glow/corona alpha and reach, and the body shade, of the suns only
    const cb = Math.max(0, st.coreBrightness === undefined ? 1 : st.coreBrightness);
    const cbReach = 0.7 + 0.3 * cb;

    // glow pass (additive)
    if (st.glow > 0) {
      ctx.globalCompositeOperation = 'lighter';
      const glowSize = Math.sqrt(st.glow);
      for (const n of m.nodes.values()) {
        if (n.isAnchor || !onScreen(n, 80)) continue;
        const isSun = m.sunSet.has(n.path), isHub = m.hubSet.has(n.path);
        // planets view: only the stars (suns + hubs) are emitters — planets
        // are lit bodies and get no glow halo (their sprite's baked atmosphere
        // rim stays). Classic view keeps glow on everything, as always.
        if (!isSun && !isHub && !n.isFolder && (ns === 'planet' || scale < 0.2)) continue; // also skip tiny glows when far out
        // pf is the perspective factor (1 in flat view): near nodes render
        // larger and brighter, far ones smaller and dimmer
        const dim = (this.hoverSet && !this.hoverSet.has(n.path) ? 0.35 : 1) *
          Math.max(0.45, Math.min(1, 1 + (n.pf - 1) * 1.6));
        const pulse = isSun ? 1 + 0.05 * Math.sin(this.T * 0.9 + n.seed % 7) : 1;
        if (coronaOn && (isSun || isHub)) {
          // corona replaces the standard glow on the big bodies. Its reach
          // rides on the glow setting multiplicatively; the strength slider
          // then scales it further on its own axis. The hub multiplier must
          // clearly beat the 4.2x standard glow it replaces (a same-size
          // corona is invisible in practice — that was the bug); in absolute
          // pixels hubs still land a distinct step below the suns because
          // their bodies are 2-5x smaller. The smallest hubs borrow a size
          // floor for the corona only (lesser suns flare disproportionately)
          // or their coronas degenerate to a few pixels. Hub alpha fades on
          // sqrt(glow) instead of glow: their bodies are too small to stay
          // visible if a low glow setting crushes both reach AND alpha (suns
          // survive on sheer size; hubs vanished).
          const br = (isSun ? n.drawR : Math.max(n.drawR, 8)) * st.nodeSize * (n.isFolder ? (st.folderSize || 1) : 1) * scale * pulse * n.pf;
          const cr = Math.min(320, br * (isSun ? 5.2 : 5.6) * glowSize * coronaCs * (isSun ? cbReach : 1));
          ctx.globalAlpha = Math.min(1, (isSun ? 0.95 * Math.min(1, st.glow) * cb : 0.9 * Math.min(1, glowSize)) * dim);
          ctx.drawImage(this.coronaSprite(this.nodeColor(n), isSun ? 'sun' : 'hub'), n.sx - cr, n.sy - cr, cr * 2, cr * 2);
          continue;
        }
        const gs = n.drawR * st.nodeSize * (n.isFolder ? (st.folderSize || 1) : 1) * (isSun ? 5.5 * cbReach : isHub ? 4.2 : 3) * scale * pulse * glowSize * n.pf;
        const spr = this.glow(this.nodeColor(n), Math.min(160, gs));
        ctx.globalAlpha = Math.min(1, (isSun ? 0.95 * cb : isHub ? 0.8 : 0.5) * dim * Math.min(1, st.glow));
        ctx.drawImage(spr, n.sx - gs, n.sy - gs, gs * 2, gs * 2);
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }

    // solid bodies (far-to-near when tilted, so near nodes overdraw far ones)
    for (const n of (proj ? this.order : m.nodes.values())) {
      if (n.isAnchor || !onScreen(n, 30)) continue;
      const isSun = m.sunSet.has(n.path);
      const dim = (this.hoverSet && !this.hoverSet.has(n.path) ? 0.3 : 1) *
        Math.max(0.45, Math.min(1, 1 + (n.pf - 1) * 1.6));
      const pulse = isSun ? 1 + 0.04 * Math.sin(this.T * 0.9 + n.seed % 7) : 1;
      const r = Math.max(0.7, n.drawR * st.nodeSize * (n.isFolder ? (st.folderSize || 1) : 1) * scale * pulse * n.pf);
      ctx.globalAlpha = dim;
      if (ns === 'planet' && !isSun && !n.isFolder && !m.hubSet.has(n.path)) {
        // multi-source lighting: every sun and hub pulls the lit side toward
        // itself, weighted by luminosity (sqrt of size, baked as .lum at
        // build) over distance squared. Why so flat: size^2 luminosity let
        // the core drown out every hub, so whole clusters faced the center
        // instead of their own hub. sqrt keeps a real ordering (a sun still
        // outweighs a hub ~1.5-2.2x at equal distance) while letting each
        // hub's own planets face THEIR hub; the core wins only when it is
        // genuinely closer or comparable. The resultant's direction aims the
        // sprite; its magnitude relative to the total weight says how
        // directional the light is — surrounded by comparable sources, the
        // shading washes toward ambient.
        let lvx = 0, lvy = 0, lw = 0;
        for (const src of m.lights) {
          const ldx = src.sx - n.sx, ldy = src.sy - n.sy;
          const ld2 = Math.max(1, ldx * ldx + ldy * ldy);
          const w = src.lum / ld2;
          const inv = 1 / Math.sqrt(ld2);
          lvx += w * ldx * inv; lvy += w * ldy * inv; lw += w;
        }
        const dirness = lw > 0 ? Math.hypot(lvx, lvy) / lw : 1;
        const lvl = Math.min(1.999, dirness >= PLANET_LIGHT.CRISP ? 0
          : dirness >= PLANET_LIGHT.SOFT
            ? (PLANET_LIGHT.CRISP - dirness) / (PLANET_LIGHT.CRISP - PLANET_LIGHT.SOFT)
            : 1 + (PLANET_LIGHT.SOFT - dirness) / PLANET_LIGHT.SOFT);
        const li = Math.floor(lvl);
        const col = this.nodeColor(n);
        const pr = r * 1.25; // sprite reaches past the body for the halo
        ctx.save();
        ctx.translate(n.sx, n.sy);
        ctx.rotate(Math.atan2(lvy, lvx));
        ctx.drawImage(this.planetSprite(col, li), -pr, -pr, pr * 2, pr * 2);
        if (lvl - li > 0.02) { // crossfade into the next level, no popping
          ctx.globalAlpha = dim * (lvl - li);
          ctx.drawImage(this.planetSprite(col, li + 1), -pr, -pr, pr * 2, pr * 2);
        }
        ctx.restore();
      } else {
        const bodyCol = this.nodeColor(n);
        ctx.fillStyle = isSun && cb !== 1 && bodyCol[0] === '#'
          ? tint(bodyCol, cb < 1 ? cb - 1 : Math.min(0.6, (cb - 1) * 0.45)) : bodyCol;
        ctx.beginPath(); ctx.arc(n.sx, n.sy, r, 0, 6.2832); ctx.fill();
        if (n.isFolder && !n.coreFolder && !n.hubFolder) { // folder: filled disc with a darker core and an outer ring
          ctx.fillStyle = '#04050d';
          ctx.beginPath(); ctx.arc(n.sx, n.sy, r * 0.5, 0, 6.2832); ctx.fill();
          if (st.folderRing !== false) {
            ctx.strokeStyle = this.nodeColor(n);
            ctx.lineWidth = Math.max(1, r * 0.18);
            ctx.beginPath(); ctx.arc(n.sx, n.sy, r * 1.35, 0, 6.2832); ctx.stroke();
          }
        }
        if (isSun) { // hot white center
          ctx.fillStyle = st.coreCenterColor || '#fff7d8';
          ctx.beginPath(); ctx.arc(n.sx, n.sy, r * 0.45, 0, 6.2832); ctx.fill();
        }
      }
    }
    ctx.globalAlpha = 1;

    // labels (screen space, always billboarded — flat and screen-facing at
    // every camera angle; in the tilted views depth reads through size only,
    // perspective-scaled within a legibility clamp)
    const label = (n, font, alpha, dy) => {
      ctx.font = font;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#dde6f5';
      ctx.textAlign = 'center';
      if (this.pj) {
        const lp = Math.max(0.85, Math.min(1.3, n.pf));
        ctx.save();
        ctx.translate(n.sx, n.sy + dy);
        ctx.scale(lp, lp);
        ctx.fillText(n.label, 0, 0);
        ctx.restore();
      } else {
        ctx.fillText(n.label, n.sx, n.sy + dy);
      }
    };
    const ls = scale / st.labelZoom; // label-gating zoom: threshold slider shifts when names appear
    const fls = scale / (st.folderLabelZoom > 0 ? st.folderLabelZoom : st.labelZoom); // same, for folder names only
    for (const n of m.nodes.values()) {
      if (!onScreen(n, 40)) continue;
      const dimmed = this.hoverSet && !this.hoverSet.has(n.path);
      const inHover = this.hoverSet && this.hoverSet.has(n.path);
      if (n.isAnchor) {
        if (ls > 0.25 && !this.hoverSet) label(n, 'italic 11px sans-serif', 0.28, 4);
        continue;
      }
      const lr = n.drawR * st.nodeSize * (n.isFolder ? (st.folderSize || 1) * (st.folderRing === false || n.coreFolder || n.hubFolder ? 1 : 1.35) : 1) * scale * n.pf;
      if (n.isFolder) {
        // structure labels: appear a little earlier than hubs
        if (st.folderLabels !== false) {
          const fs = st.folderLabelSize || 11;
          const a = Math.min(0.85, Math.max(0, (fls - 0.12) * 2.6));
          if ((a > 0.05 && !dimmed) || inHover) label(n, (n.coreFolder ? 'bold ' : 'italic ') + fs + 'px sans-serif', inHover ? 0.95 : a, lr + fs + 2);
        }
      } else if (m.sunSet.has(n.path)) {
        if (st.sunLabels) {
          if (!dimmed) label(n, 'bold 12px sans-serif', 0.9, lr + 14);
        } else { // zoom-gated like the rest of the galaxy
          const a = Math.min(0.9, Math.max(0, (ls - 0.35) * 2.6));
          if ((a > 0.05 && !dimmed) || inHover) label(n, 'bold 12px sans-serif', inHover ? 0.95 : a, lr + 14);
        }
      } else if (m.hubSet.has(n.path)) {
        const a = Math.min(0.8, Math.max(0, (ls - 0.18) * 2.6));
        if ((a > 0.05 && !dimmed) || inHover) label(n, '11px sans-serif', inHover ? 0.9 : a, lr + 12);
      } else if (inHover || ls > 1.1) {
        // ramp saturates by ls≈1.9 so max zoom is fully readable even with the
        // label threshold maxed (scale 6 / threshold 3 -> ls 2)
        if (!dimmed) label(n, '10px sans-serif', inHover ? 0.85 : Math.min(0.85, (ls - 1.1) * 1.1), lr + 10);
      }
    }
    ctx.globalAlpha = 1;

    // hover tooltip: full path, bottom-center
    if (this.hover) {
      ctx.font = '11px sans-serif';
      ctx.globalAlpha = 0.75;
      ctx.fillStyle = '#aebedd';
      ctx.textAlign = 'center';
      ctx.fillText(this.hover.isFolder ? this.hover.folderPath + '/' : this.hover.path, this.w / 2, this.h - 10);
      ctx.globalAlpha = 1;
    }
  }
}

/* --------------------------------------------------------- settings tab */

class GalaxySettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this._open = { folders: true, core: true }; // which sections are expanded (kept across re-renders)
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('vgf-tab');

    const plugin = this.plugin;
    const S = new Proxy({}, { // always the CURRENT settings object, even if the panel's reset replaced it
      get: (_, k) => plugin.settings[k],
      set: (_, k, v) => { plugin.settings[k] = v; return true; },
    });
    const save = async () => { await plugin.saveSettings(); };
    const rebuildViews = () => {
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
        if (leaf.view && leaf.view.build) { leaf.view.build(); leaf.view.buildPanel(leaf.view.contentEl); }
      }
    };

    // ---- small builders: every control writes straight to the settings and applies live
    const section = (key, title, hint, parent) => {
      const d = (parent || containerEl).createEl('details', { cls: 'vgf-details' });
      d.open = !!this._open[key];
      d.addEventListener('toggle', () => { this._open[key] = d.open; });
      d.createEl('summary', { text: title });
      const body = d.createDiv({ cls: 'vgf-body' });
      if (hint) body.createEl('p', { text: hint, cls: 'setting-item-description' });
      return body;
    };
    const toggle = (parent, name, desc, key, dflt, rebuild) => new Setting(parent).setName(name).setDesc(desc)
      .addToggle((t) => t.setValue(S[key] === undefined ? dflt : !!S[key])
        .onChange(async (v) => { S[key] = v; await save(); if (rebuild) rebuildViews(); }));
    const slider = (parent, name, desc, key, min, max, step, dflt, rebuild) => new Setting(parent).setName(name).setDesc(desc)
      .addSlider((sl) => sl.setLimits(min, max, step)
        .setValue(S[key] === undefined ? dflt : S[key])
        .setDynamicTooltip()
        .onChange(async (v) => { S[key] = v; await save(); if (rebuild) rebuildViews(); }));
    const dropdown = (parent, name, desc, key, options, dflt, rebuild) => new Setting(parent).setName(name).setDesc(desc)
      .addDropdown((d) => {
        for (const [val, label] of options) d.addOption(val, label);
        d.setValue(S[key] || dflt).onChange(async (v) => { S[key] = v; await save(); if (rebuild) rebuildViews(); });
      });
    const textRule = (parent, name, desc, key, placeholder) => new Setting(parent).setName(name).setDesc(desc)
      .addTextArea((ta) => {
        ta.setPlaceholder(placeholder).setValue(S[key] || '')
          .onChange(async (v) => { S[key] = v; await save(); rebuildViews(); });
        ta.inputEl.rows = 3;
      });

    // ================= 1. Folders =================
    const fol = section('folders', 'Folders', 'Show your folders as nodes, and choose how they look.');
    toggle(fol, 'Folders as nodes', 'Every folder becomes a node linked to its notes and to its parent folder.', 'showFolders', true, true);
    toggle(fol, 'Folders as core notes', 'Draw folders like core notes: big suns with a corona that light the notes around them.', 'folderAsCore', false, true);
    toggle(fol, 'Subfolders as hub notes', 'Draw subfolders (every level below the top) like hub notes: orange stars with a corona.', 'folderAsHub', false, true);
    slider(fol, 'Folder size', 'Size of the folder nodes (1 = default).', 'folderSize', 0.3, 3, 0.05, 1, false);
    new Setting(fol).setName('Folder color').setDesc('Default color of the folder nodes. Individual folders can override it in "Folder colors" below.')
      .addColorPicker((cp) => cp.setValue((S.colors && S.colors.folder) || TIERS.folder.color)
        .onChange(async (v) => { S.colors = S.colors || {}; S.colors.folder = v; await save(); }))
      .addExtraButton((b) => b.setIcon('rotate-ccw').setTooltip('Back to default')
        .onClick(async () => { if (S.colors) delete S.colors.folder; await save(); this.display(); }));
    slider(fol, 'Folder name threshold', 'How far you must zoom before folder names appear. Higher = names stay hidden until you are closer (up to 20). 0 = same as the general label threshold.', 'folderLabelZoom', 0, 20, 0.1, 0, false);

    const more = section('foldersMore', 'More folder options', '', fol);
    dropdown(more, 'Which folders are core', 'When "Folders as core notes" is on: top-level folders only, or every folder.', 'folderCoreLevel',
      [['top', 'Top-level folders only'], ['all', 'All folders']], 'top', true);
    toggle(more, 'Ring around folders', 'Draw an outer ring on plain folder nodes so they stand out from notes.', 'folderRing', true, false);
    toggle(more, 'Folder names', 'Show folder names on the graph.', 'folderLabels', true, false);
    slider(more, 'Folder name size', 'Font size of folder names, in pixels.', 'folderLabelSize', 8, 24, 1, 11, false);
    new Setting(more).setName('Folder line color').setDesc('Lines linking folders to their notes. Reset = each line takes its folder\'s color.')
      .addColorPicker((cp) => cp.setValue(S.folderLineColor || (S.colors && S.colors.folder) || TIERS.folder.color)
        .onChange(async (v) => { S.folderLineColor = v; await save(); }))
      .addExtraButton((b) => b.setIcon('rotate-ccw').setTooltip('Use each folder\'s color')
        .onClick(async () => { S.folderLineColor = ''; await save(); this.display(); }));
    slider(more, 'Folder line thickness', 'Thickness of the folder lines.', 'folderLineWidth', 0.2, 4, 0.1, 1, false);
    slider(more, 'Folder line brightness', 'Visibility of the folder lines.', 'folderLineAlpha', 0.2, 5, 0.1, 1, false);
    slider(more, 'Folder distance', 'How far folders sit from the center and from their parent folder.', 'folderSpread', 0.5, 2, 0.05, 1, true);
    new Setting(more).setName('Reset folder settings').setDesc('Sizes, rings, names and lines go back to default. Folder colors are kept.')
      .addButton((b) => b.setButtonText('Reset').onClick(async () => {
        for (const k of ['folderAsCore', 'folderAsHub', 'folderCoreLevel', 'folderSize', 'folderRing', 'folderLabels', 'folderLabelSize',
          'folderLabelZoom', 'folderLineWidth', 'folderLineAlpha', 'folderLineColor', 'folderSpread']) S[k] = DEFAULT_SETTINGS[k];
        if (S.colors) delete S.colors.folder;
        await save(); this.display(); rebuildViews();
      }));

    // ================= 2. Core nodes =================
    const core = section('core', 'Core nodes', 'The suns of the galaxy: which notes or folders are core, where they sit, how they shine.');
    dropdown(core, 'Core position', 'Orbiting: core folders ride the outer ring. Centered: the biggest core sits in the middle like the original galaxy and the others orbit it. Centered and fixed: same, but nothing orbits.', 'coreLayout',
      [['orbit', 'Orbiting (default)'], ['center', 'Centered'], ['fixed', 'Centered and fixed']], 'orbit', true);
    slider(core, 'Automatic core notes', 'How many of your most-linked notes become suns when no Core rule matches. 0 = none.', 'autoCoreCount', 0, 10, 1, 5, true);
    slider(core, 'Automatic hub notes', 'How many of the next most-linked notes become hubs when no Hub rule matches. 0 = none.', 'autoHubCount', 0, 20, 1, 8, true);
    slider(core, 'Core brightness', 'Glow, corona and body brightness of core nodes only (1 = default).', 'coreBrightness', 0, 2.5, 0.05, 1, false);
    new Setting(core).setName('Core center color').setDesc('Color of the hot center of core nodes.')
      .addColorPicker((cp) => cp.setValue(S.coreCenterColor || DEFAULT_SETTINGS.coreCenterColor)
        .onChange(async (v) => { S.coreCenterColor = v; await save(); }))
      .addExtraButton((b) => b.setIcon('rotate-ccw').setTooltip('Back to default')
        .onClick(async () => { S.coreCenterColor = DEFAULT_SETTINGS.coreCenterColor; await save(); this.display(); }));

    // ================= 3. Folder colors =================
    const fc = section('colors', 'Folder colors',
      'Pick a color for any folder. It recolors the folder node and every note inside it (the planets); ' +
      'subfolders inherit it unless they have their own. Core and hub notes keep their gold and orange.');
    const folderList = listVaultFolders(this.app);
    const listEl = fc.createDiv();
    const defaultFolderColor = () => (S.colors && S.colors.folder) || TIERS.folder.color;
    const renderFolderList = (filter) => {
      listEl.empty();
      const f = (filter || '').trim().toLowerCase();
      for (const d of folderList) {
        if (f && !d.toLowerCase().includes(f)) continue;
        const depth = d.split('/').length - 1;
        const row = new Setting(listEl)
          .setName(d.split('/').pop())
          .setDesc(depth ? d : '')
          .addColorPicker((cp) => cp
            .setValue(folderOverride(S, d) || defaultFolderColor())
            .onChange(async (v) => { S.folderColors = S.folderColors || {}; S.folderColors[d] = v; await save(); }))
          .addExtraButton((b) => b.setIcon('rotate-ccw').setTooltip('Remove this folder\'s color')
            .onClick(async () => { if (S.folderColors) delete S.folderColors[d]; await save(); renderFolderList(filter); }));
        if (row.settingEl) row.settingEl.style.paddingLeft = (depth * 20) + 'px';
      }
      if (!listEl.childElementCount) listEl.createEl('p', { text: 'No folder found.', cls: 'setting-item-description' });
    };
    new Setting(fc).setName('Find a folder')
      .addText((t) => t.setPlaceholder('type to filter').onChange((v) => renderFolderList(v)))
      .addButton((b) => b.setButtonText('Reset all folder colors').onClick(async () => {
        S.folderColors = {}; await save(); renderFolderList('');
      }));
    renderFolderList('');

    // ================= 4. Display =================
    const dsp = section('display', 'Display');
    dropdown(dsp, 'Node style', 'Classic draws every note as a glowing disc. Planets keeps suns and hubs classic and renders every smaller note as a shaded planet.', 'nodeStyle',
      [['disc', 'Classic'], ['planet', 'Planets']], 'disc', false);
    slider(dsp, 'Label threshold', 'How far you must zoom before note names appear. Lower = names appear sooner.', 'labelZoom', 0.3, 3, 0.05, 3, false);
    toggle(dsp, 'Corona', 'Flare the suns and hubs with a layered bloom and ray spikes.', 'corona', true, false);
    slider(dsp, 'Corona strength', 'How far the corona reaches.', 'coronaStrength', 0.2, 2.5, 0.05, 1, false);
    toggle(dsp, 'Idle drift', 'In the tilted views, slowly rotate the galaxy after a few hands-off seconds.', 'idleSpin', true, false);

    // ================= 5. Vault structure rules =================
    const rules = section('rules', 'Vault structure rules',
      'All optional. Patterns are vault paths, one per line, * matches anything. Leave Core and Hub empty to let the galaxy auto-detect them.');
    textRule(rules, 'Core notes (suns)', 'Notes that anchor the center of the galaxy. Example: notes/index.md or MOCs/*', 'coreRules', 'MOCs/*\nhome.md');
    textRule(rules, 'Hub notes (orange stars)', 'Router/index notes that orbit the suns and collect their own moons.', 'hubRules', 'MOCs/sub-*');
    textRule(rules, 'Never core / hub (exclusions)', 'Notes matching these patterns are never promoted to core or hub automatically (explicit Core/Hub rules still apply).', 'excludeRules', 'Journal/*\nInbox');
    textRule(rules, 'Archive folders', 'Folders rendered as dim debris at the galaxy rim.', 'archiveFolders', 'archive');
    textRule(rules, 'Folder groups (colored clusters)', 'Folders that get their own color (and their own satellite cluster in expand mode). Empty = every top-level folder automatically.', 'folderGroups', 'Projects\nAreas\nResources');
  }
}

/* ----------------------------------------------------------------- plugin */

class VaultGalaxyPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.registerView(VIEW_TYPE, (leaf) => new GalaxyView(leaf, this));
    this.addRibbonIcon('orbit', 'Open Vault Galaxy', () => this.activateView());
    this.addCommand({ id: 'open', name: 'Open galaxy view', callback: () => this.activateView() });
    this.addSettingTab(new GalaxySettingTab(this.app, this));

    // first-ever load: open the galaxy once so it introduces itself
    this.app.workspace.onLayoutReady(async () => {
      if (!this.data.opened) {
        await this.activateView();
        this.data.opened = true;
        await this.saveSettings();
      }
    });
  }

  async loadSettings() {
    this.data = (await this.loadData()) || {};
    this.settings = {
      ...DEFAULT_SETTINGS, ...(this.data.settings || {}),
      colors: { ...((this.data.settings || {}).colors || {}) },
      folderColors: { ...((this.data.settings || {}).folderColors || {}) },
    };
    // earlier builds stored the tilt as a boolean
    if (typeof this.settings.tilt === 'boolean') this.settings.tilt = this.settings.tilt ? 'tilt' : 'flat';
    // earlier builds had 'star' and 'hybrid' node styles; both fold into planets
    if (this.settings.nodeStyle === 'star' || this.settings.nodeStyle === 'hybrid') this.settings.nodeStyle = 'planet';
  }

  async saveSettings() {
    this.data.settings = this.settings;
    await this.saveData(this.data);
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }
}

module.exports = VaultGalaxyPlugin;
