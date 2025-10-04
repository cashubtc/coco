import { defineConfig } from 'vitepress';

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: 'Coco Cashu Docs',
  description: 'Cashu out of the box',
  base: '/coco/',
  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Get Started', link: '/starting/start-here' },
    ],

    sidebar: [
      {
        text: 'Starting',
        items: [{ text: 'Start Here', link: '/starting/start-here' }],
      },
      {
        text: 'Core',
        collapsed: true,
        items: [
          { text: 'Storage Adapters', link: '/pages/storage-adapters' },
          { text: 'Bip39', link: '/pages/bip39' },
          { text: 'Watchers & Processors', link: '/pages/watchers-processors' },
        ],
      },
      {
        text: 'Examples',
      },
    ],

    socialLinks: [{ icon: 'github', link: 'https://github.com/cashubtc/coco' }],
  },
});
