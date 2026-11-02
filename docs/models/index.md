# Providers and models

FreeGent spreads work over many free-tier and local models instead of depending on one. These pages cover where the models come from and how FreeGent switches between them.

| Page | Covers |
|---|---|
| [Default providers](providers.md) | The providers FreeGent ships with, where to get keys, and the variable names |
| [Access without your own key](access.md) | Guest access (which providers it covers, its limits) and the Developer key |
| [Priority, fallbacks and retries](rotation.md) | The model priority list, cooldowns, rotation, retries and thinking level |
| [How requests reach providers](proxy.md) | The hosted proxy, the Worker, and when you need your own |
| [Local models](local-models.md) | Ollama, vLLM, LM Studio and any OpenAI-compatible server |

On freegent.ai the only setup is pasting an API key, and while FreeGent offers [guest access](access.md#guest-access) you can start without one. Besides the default providers, any OpenAI-compatible endpoint can be added as a custom model.
