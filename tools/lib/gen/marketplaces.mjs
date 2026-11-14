// tools/lib/gen/marketplaces.mjs: root marketplace files.
// Plugins are the included ones, ordered by name; the version is never duplicated into entries.

export const DEFAULT_CATEGORY = 'Productivity';
export const DEFAULT_CODEX_POLICY = Object.freeze({ authentication: 'ON_INSTALL', installation: 'AVAILABLE' });

export function category(plugin, repo) {
  return plugin.src.category ?? repo.config.codex?.defaultCategory ?? DEFAULT_CATEGORY;
}

/** Per-key merge: built-in default < marketplace.config codex.policy < plugin.src codex.policy. */
export function codexPolicy(plugin, repo) {
  return { ...DEFAULT_CODEX_POLICY, ...(repo.config.codex?.policy ?? {}), ...(plugin.src.codex?.policy ?? {}) };
}

export function claudeMarketplace(repo) {
  return {
    metadata: { description: repo.config.description },
    name: repo.mkt,
    owner: { ...repo.owner },
    plugins: repo.included.map((p) => {
      const e = { category: category(p, repo), description: p.src.description, name: p.name, source: `./${p.dir}` };
      if (p.src.keywords !== undefined) e.keywords = p.src.keywords;
      return e;
    }),
  };
}

export function codexMarketplace(repo) {
  return {
    interface: { displayName: repo.config.displayName },
    name: repo.mkt,
    plugins: repo.included.map((p) => ({
      category: category(p, repo),
      name: p.name,
      policy: codexPolicy(p, repo),
      source: { path: `./${p.dir}`, source: 'local' },
    })),
  };
}

export function marketplaceFiles(repo) {
  return [
    { rel: '.claude-plugin/marketplace.json', value: claudeMarketplace(repo) },
    { rel: '.agents/plugins/marketplace.json', value: codexMarketplace(repo) },
  ];
}
