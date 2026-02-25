<script lang="ts">
  import { useMints, useBalance } from '$lib/index.js';

  const mintState = useMints();
  const balanceState = useBalance();

  let mintUrl = $state('https://testnut.cashu.space');
  let loading = $state(false);
  let error = $state('');

  async function handleAddMint() {
    if (!mintUrl.trim()) return;
    loading = true;
    error = '';
    try {
      await mintState.addMint(mintUrl, {trusted: true});
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      console.error('Failed to add mint:', e);
    } finally {
      loading = false;
    }
  }
</script>

<div>
  <h2>Balance</h2>
  <p>Total: {balanceState.balance.total}</p>

  <h2>Mints ({mintState.mints.length})</h2>
  <ul>
    {#each mintState.mints as mint}
      <li>{mint.mintUrl}</li>
    {/each}
  </ul>

  <h2>Add Mint</h2>
  <input type="text" bind:value={mintUrl} placeholder="Mint URL" />
  <button onclick={handleAddMint} disabled={loading}>
    {loading ? 'Adding…' : 'Add Mint'}
  </button>
  {#if error}
    <p style="color: red">{error}</p>
  {/if}
</div>
