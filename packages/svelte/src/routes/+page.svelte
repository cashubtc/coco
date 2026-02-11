<script lang="ts">
  import CocoCashuProvider from '$lib/components/CocoCashuProvider.svelte';
  import WalletDemo from './WalletDemo.svelte';
  import { initializeCoco } from 'coco-cashu-core';
  import { IndexedDbRepositories } from 'coco-cashu-indexeddb';

  const repo = new IndexedDbRepositories({ name: 'coco' });
  const seedGetter = () => {
    return Promise.resolve(
      new TextEncoder().encode(
        'diagram update install barely reject arena pet poet riot ivory please answer',
      ),
    );
  };
  const cocoPromise = initializeCoco({ repo, seedGetter });
</script>

<h1>Testing page for coco-cashu svelte</h1>
<p>
  Visit <a href="https://svelte.dev/docs/kit">svelte.dev/docs/kit</a> to read the documentation
</p>

{#await cocoPromise}
  <p>Loading wallet…</p>
{:then manager}
  <CocoCashuProvider {manager}>
    <WalletDemo />
  </CocoCashuProvider>
{:catch error}
  <p style="color: red">Failed to initialize: {error.message}</p>
{/await}
