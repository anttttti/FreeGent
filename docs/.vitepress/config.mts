import { defineConfig } from 'vitepress';

const GH = 'https://github.com/anttttti/FreeGent';

// Served at https://freegent.ai/docs/ next to the app. `npm run docs:build` writes to dist/docs and must
// run after `npm run build`, which empties dist/.
export default defineConfig({
  title: 'FreeGent',
  description: 'An AI agent for free-tier cloud models and local models: WebUI, terminal UI and CLI.',
  base: '/docs/',
  outDir: '../dist/docs',
  cleanUrls: true,
  lastUpdated: false,
  // Only the user guide is published. Contributor material (ADRs, prompt snapshots, the Shiro inventory,
  // the GitHub index page) stays in the repository.
  srcExclude: ['README.md', 'prompts/**', 'shiro/**', 'shiro-commands*.md', 'example-system-prompts.md'],
  themeConfig: {
    nav: [
      { text: 'Open the app', link: 'https://freegent.ai/', target: '_self' },
      { text: 'GitHub', link: GH },
    ],
    sidebar: [
      { text: 'Overview', link: '/overview' },
      {
        text: 'WebUI',
        link: '/webui/',
        items: [
          { text: 'Project', link: '/webui/project/', items: [{ text: 'Media and previews', link: '/webui/project/media' }] },
          { text: 'Tasks', link: '/webui/tasks' },
          { text: 'Chats', link: '/webui/chats/', items: [{ text: 'Modes: Chat and Cowork', link: '/webui/chats/modes' }] },
          { text: 'Settings', link: '/webui/settings' },
        ],
      },
      {
        text: 'Providers and models',
        link: '/models/',
        items: [
          { text: 'Default providers', link: '/models/providers' },
          { text: 'Fallbacks and retries', link: '/models/rotation' },
          { text: 'How requests reach providers', link: '/models/proxy' },
          { text: 'Local models', link: '/models/local-models' },
        ],
      },
      {
        text: 'Harness',
        link: '/harness/',
        items: [
          { text: 'Tools', link: '/harness/tools' },
          { text: 'Roles and sub-agents', link: '/harness/roles' },
          { text: 'Skills and rules', link: '/harness/skills' },
          { text: 'MCP servers', link: '/harness/mcp' },
          { text: 'Context and compaction', link: '/harness/context' },
          { text: 'Checks and approval', link: '/harness/checks' },
        ],
      },
      {
        text: 'Code execution',
        link: '/code-execution/',
        items: [
          { text: 'Browser sandboxes', link: '/code-execution/browser' },
          { text: 'Local execution', link: '/code-execution/local' },
        ],
      },
      {
        text: 'Local or self-hosted',
        link: '/local/',
        items: [
          { text: 'WebUI', link: '/local/webui' },
          { text: 'TUI', link: '/local/tui' },
          { text: 'CLI', link: '/local/cli' },
        ],
      },
      {
        text: 'More',
        items: [
          { text: 'Cloudflare Worker', link: `${GH}/blob/main/cf-worker/README.md` },
          { text: 'Security', link: `${GH}/blob/main/SECURITY.md` },
          { text: 'Privacy', link: '/privacy' },
          { text: 'Contributing', link: '/contributing' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: GH }],
    search: { provider: 'local' },
    outline: [2, 3],
    footer: { message: 'Released under the MIT License.' },
  },
});
