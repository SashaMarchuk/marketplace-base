// tools/lib/gen/manifests.mjs: per-plugin host manifests.
// Both hosts get the same key set: {author, description, homepage?, keywords?, license?, name,
// repository?, version}. Optional source fields are omitted when absent. `author` defaults to the
// marketplace owner. Codex `interface`/`skills` are not emitted in v1.

const OPTIONAL = ['homepage', 'keywords', 'license', 'repository'];

/** The manifest object shared by `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json`. */
export function pluginManifest(plugin, repo, version) {
  const src = plugin.src;
  const m = {
    author: src.author ?? { ...repo.owner },
    description: src.description,
    name: src.name,
    version,
  };
  for (const k of OPTIONAL) if (src[k] !== undefined) m[k] = src[k];
  return m;
}

/** [{ rel, value }] for one plugin. */
export function manifestFiles(plugin, repo, version) {
  const m = pluginManifest(plugin, repo, version);
  return [
    { rel: `${plugin.dir}/.claude-plugin/plugin.json`, value: m },
    { rel: `${plugin.dir}/.codex-plugin/plugin.json`, value: m },
  ];
}
