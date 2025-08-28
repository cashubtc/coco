import { useEffect, useState } from "react";
import { manager } from "../main";

const useBalances = () => {
  const [balances, setBalances] = useState<{ [mintUrl: string]: number }>({});
  useEffect(() => {
    async function updateBalance() {
      const b = await manager.wallet.getBalances();
      setBalances(b);
    }
    manager.on("proofs:saved", updateBalance);
    manager.on("proofs:state-changed", updateBalance);
    updateBalance();
  }, []);
  return balances;
};

export default useBalances;
