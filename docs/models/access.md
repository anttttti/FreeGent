# Access without your own key

Every model call needs an API key for its provider. FreeGent uses one of three, in this order:

1. **Your own key**, from Settings → Credentials (or the credentials file when you run FreeGent yourself). It always comes first.
2. **Guest access**, while FreeGent offers it: a limited quota on FreeGent's own free-tier accounts for a few providers, for visitors who have not added a key yet.
3. **The Developer key**, for the person who runs the Worker: it unlocks all of the Worker's own keys for their own sessions.

The keys behind 2 and 3 are the Worker's keys ("Worker keys"). They are stored as secrets in FreeGent's Cloudflare Worker and never reach your browser: the Worker makes the request with the key and returns the answer. So both work only at the **Routed** privacy level, where requests go through the Worker. See [How requests reach providers](proxy.md).

| | Your own key | Guest access | Developer key |
|---|---|---|---|
| Who | Anyone | Visitors without a key for that provider, while FreeGent has it switched on | The Worker's operator only |
| Providers | All of them | Groq, Kilo, OpenRouter, TokenHarbor | Every provider the Worker has a key for |
| Limits | Your provider's free tier or plan | A daily number of requests per network (150 by default), shared quota | The operator's own accounts |
| Privacy level | Any | Routed | Routed |
| Whose account the provider sees | Yours | FreeGent's | The operator's |

## Guest access

Guest access lets you try FreeGent before getting a key. At the default Routed privacy level, the page checks the Worker on each load without a Developer key. While FreeGent offers guest access, the models of the providers below are simply available: they show up in Settings → Models and in the model picker like models you have a key for. If guest access is disabled and no credentials are saved, the page opens Settings → Credentials. If you choose Provider-only, sending a message with no usable key on freegent.ai shows **No API key yet** with two choices:

- **Use the guest quota**: Privacy switches to Routed, Cloudflare's bot check runs once (usually invisibly), and your message runs on a guest model.
- **Add my own key**: opens Settings → Credentials. [Default providers](providers.md) lists where to get free keys.

At Provider-only nothing is sent to the Worker until you choose the guest quota.

### Providers covered

| Provider | Default models it serves as a guest |
|---|---|
| Kilo | Beam, Crouton Alpha, Nemotron 3.5 Super VL |
| OpenRouter | Nemotron 3.5 Super VL |
| TokenHarbor | DeepSeek V4.1 Flash, MiMo V2.6 Flash |
| Groq | none in the default list; Groq models you add to Model Priority are covered |

Only these four providers are covered because their terms allow a service to run its users' requests on its own account. The others do not: Gemini's free tier may not serve users in the EEA, Switzerland or the UK, NVIDIA's API trial and Vercel may not be used for others, and Nous Portal and MoonMath's free plan are for the account holder's own use. With guest access, any model from the four providers works, including ones you add yourself; the table shows those in the shipped priority list.

### Limits and conditions

- **Shared quota.** Everyone uses the same free-tier accounts, so a provider can run out for everyone before the day ends. The guest models then fail with that provider's rate-limit error, and FreeGent moves on as with any provider.
- **Daily limit per network.** Each network (an IPv4 address, or an IPv6 /64) gets 150 guest requests per UTC day by default. After that, the guest models are paused in your browser until 00:00 UTC, and requests say so.
- **Your own key first.** A key of your own for Groq, Kilo, OpenRouter or TokenHarbor is always used instead of the guest quota.
- **Terms and training.** The providers' terms apply: [Groq](https://console.groq.com/docs/legal), [Kilo](https://kilo.ai/terms), [OpenRouter](https://openrouter.ai/terms), [TokenHarbor](https://tokenharbor.ai/terms). Some free models may use prompts for training, so do not send anything private.
- **It can be switched off at any time.** FreeGent checks again when you return to the tab and every few minutes; a request made after it is switched off says "The guest quota is off right now", and the guest models leave the lists.

**Settings → Models** shows **Guest access: Enabled** or **Disabled** next to the Model Selections heading: whether FreeGent's Worker has it switched on. Point at it for an explanation. It is a status, not a setting: only the Worker's operator switches it. At Provider-only and Local, and on a local server, the page does not ask the Worker, so it shows Disabled.

What guest access sends where is listed under [Privacy](../privacy.md#what-leaves-your-device): the provider sees FreeGent's account, not you, and OpenRouter also gets a random ID per session so that a policy block affects one guest only.

## Developer key

The Developer key is a secret that the operator of a Worker sets on it (`FG_DEV_KEY`) and pastes into Settings → Credentials → **Developer key**. With it, that browser's requests through the Worker can use every Worker key, without the guest limits and without the bot check. It also turns on uploads of console errors and finished Autopilot chats to the operator's logs, and project sync. Saving it switches Privacy to Routed.

It is meant for one person: the Worker's operator. It is never needed to use FreeGent, and it must not be shared, because it unlocks every key on the Worker, including providers whose terms forbid serving other people. To let others use your keys within those terms, use guest access instead.

## Running your own Worker

If you host FreeGent and its Worker yourself, Worker keys, the Developer key and guest access are yours to set up: provider keys and `FG_DEV_KEY` as Worker secrets, and `FG_GUEST_QUOTA` (with `FG_GUEST_DAILY` for the daily limit) to switch guest access on or off without a code change. See [Hosting your own site and Worker](../local/webui.md#hosting-your-own-site-and-worker) and the [Worker README](https://github.com/anttttti/FreeGent/blob/main/cf-worker/README.md#worker-keys-and-the-guest-quota-optional).
