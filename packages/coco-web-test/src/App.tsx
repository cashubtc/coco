import { useState } from "react";
import useBalances from "./hooks/useBalances";
import { manager } from "./main";
import { getEncodedToken } from "@cashu/cashu-ts";

const mintUrl = "https://nofees.testnut.cashu.space";

function App() {
  const balances = useBalances();
  const [token, setToken] = useState("");
  console.log(balances);
  async function mintNewProofs() {
    const mintQuote = await manager.quotes.createMintQuote(mintUrl, 21);
    await manager.quotes.redeemMintQuote(mintUrl, mintQuote.quote);
  }

  async function send() {
    const token = await manager.wallet.send(mintUrl, 10);
    setToken(getEncodedToken(token));
  }
  return (
    <main>
      <div>
        <p>Balances:</p>
        {Object.entries(balances).map((e) => (
          <div className="flex gap-2">
            <p>{e[0]}:</p>
            <p>{e[1]}</p>
          </div>
        ))}
      </div>
      <button onClick={mintNewProofs} className="px-2 py-1 bg-zinc-500 rounded">
        Mint
      </button>
      <button onClick={send} className="px-2 py-1 bg-zinc-500 rounded">
        Send 10
      </button>
      {token ? <p>{token}</p> : undefined}
    </main>
  );
}

export default App;
