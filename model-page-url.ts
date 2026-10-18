// Returns the canonical web page URL for a provider/model combination.
// Used in the catalog table and the model-update modal.
export function modelPageUrl(provider: string, model: string): string {
    switch (provider) {
        case 'openrouter':
            // Strip :free suffix — the page exists at the bare model path
            return `https://openrouter.ai/${model.replace(/:free$/, '')}`;
        case 'nvidia':
            return `https://build.nvidia.com/${model}`;
        case 'google':
            // Gemma models have a separate docs page from Gemini
            if (model.startsWith('gemma')) return 'https://ai.google.dev/gemma/docs/gemma-models';
            // Gemini: anchor by model name (e.g. #gemini-2.5-flash-lite)
            return `https://ai.google.dev/gemini-api/docs/models#${model}`;
        case 'groq':
            return 'https://console.groq.com/docs/models';
        case 'nous':
            // Models are vendor/name:free (e.g. stepfun/step-3.7-flash:free).
            // OpenRouter hosts the canonical model pages; Nous Portal index for the provider link.
            return model.includes('/')
                ? `https://openrouter.ai/${model.replace(/:free$/, '')}`
                : 'https://portal.nousresearch.com/models';
        case 'tokenharbor':
            return 'https://tokenharbor.ai/models';
        case 'kilo':
            return 'https://kilo.ai/models';
        case 'vercel':
            return 'https://vercel.com/ai-gateway/models';
        default:
            return '';
    }
}
