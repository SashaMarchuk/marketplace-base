# {{displayName}}

Agent skills for **Claude Code**, **Codex** and any tool that reads a skills folder.

Describe here what this marketplace is for and who maintains it.

## Install

<!-- mb:install:begin -->
<!-- mb:install:end -->

Then just ask your agent; skills fire when your request matches them. See [USAGE.md](USAGE.md) for updating, configuration and uninstalling.

## Catalog

<!-- mb:catalog:begin -->
<!-- mb:catalog:end -->

## Contributing

Add a skill in under 10 minutes: see [CONTRIBUTING.md](CONTRIBUTING.md).

```sh
./mb new skill <plugin>/<skill> "What it does. Use when ..."
./mb gen && ./mb check
```

## Built on marketplace-base

This repo is derived from [marketplace-base]({{baseUrl}}). Base docs are in [docs/base/](docs/base/); pull base updates with `./mb base-update` (see [docs/base/derive-update.md](docs/base/derive-update.md)).

Example plugins under `examples/plugins/` belong to the base and are overwritten by `./mb base-update`: run `./mb adopt <p>` before you edit one. To drop one, adopt it and delete `plugins/<p>`, or remove it from `includeExamples` in `marketplace.config.json` and delete its folder.

## License

[MIT](LICENSE)
