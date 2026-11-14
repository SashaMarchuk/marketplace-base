// CHK-05: skill names unique across the marketplace, so a flat export works (SPEC section 12).

export const id = 'CHK-05';
export const severity = 'error';
export const title = 'Skill names unique across the marketplace (flat export)';
export const fix = 'rename skill';

export function run(rctx) {
  const owners = new Map(); // skill -> [plugin dirs]
  for (const p of rctx.allPlugins) {
    for (const s of rctx.skills(p)) owners.set(s, [...(owners.get(s) ?? []), p.dir]);
  }
  const out = [];
  for (const p of rctx.plugins) {
    for (const s of rctx.skills(p)) {
      const others = owners.get(s).filter((d) => d !== p.dir);
      if (others.length) out.push({ path: `${p.dir}/skills/${s}`, message: `skill "${s}" also exists in ${others.join(', ')}` });
    }
  }
  return out;
}
