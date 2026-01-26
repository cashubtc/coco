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
        items: [
          { text: 'Start Here', link: '/starting/start-here' },
          { text: 'Adding Mints', link: '/starting/adding-mints' },
          { text: 'Subscriptions', link: '/starting/subscriptions' },
          { text: 'Minting Tokens', link: '/starting/minting' },
          { text: 'Melting Tokens', link: '/starting/melting' },
          { text: 'Sending & Receiving', link: '/starting/sending-receiving' },
          { text: 'Payment Requests', link: '/starting/payment-requests' },
        ],
      },
      {
        text: 'Examples',
        items: [{ text: 'Node', link: '/examples/node' }],
      },
      {
        text: 'Core',
        collapsed: true,
        items: [
          { text: 'Storage Adapters', link: '/pages/storage-adapters' },
          { text: 'Bip39', link: '/pages/bip39' },
          { text: 'KeyRing (P2PK)', link: '/pages/keyring' },
          { text: 'Watchers & Processors', link: '/pages/watchers-processors' },
          { text: 'Send Operations', link: '/pages/send-operations' },
          { text: 'Melt Operations', link: '/pages/melt-operations' },
          { text: 'Coco Config', link: '/pages/coco-config' },
          { text: 'Plugins', link: '/pages/plugins' },
        ],
      },
      {
        text: 'React',
        collapsed: true,
        items: [
          { text: 'Overview', link: '/pages/react-overview' },
          { text: 'Providers & Contexts', link: '/pages/react-providers' },
          { text: 'Hooks', link: '/pages/react-hooks' },
        ],
      },
    ],

    socialLinks: [{ icon: 'github', link: 'https://github.com/cashubtc/coco' }],
  },
});
