import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Milkerfun } from "../target/types/milkerfun";
import { getAccount } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";

/**
 * Status checker script - shows current state of the program and user
 */
async function main() {
  // Set up provider manually to avoid env variable issues
  const connection = new anchor.web3.Connection(
    process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com"
  );
  
  // Load wallet from default Solana CLI location
  const walletPath = process.env.ANCHOR_WALLET || `${os.homedir()}/.config/solana/id.json`;
  const walletKeypair = anchor.web3.Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(walletPath, 'utf8')))
  );
  
  const wallet = new anchor.Wallet(walletKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {});
  anchor.setProvider(provider);

  const program = anchor.workspace.milkerfun as Program<Milkerfun>;

  console.log("=== MilkerFun Status ===");
  console.log("Program ID:", program.programId.toString());
  console.log("User:", wallet.publicKey.toString());
  console.log("Cluster:", provider.connection.rpcEndpoint);

  try {
    // Get config
    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    const config = await program.account.config.fetch(configPda);
    
    console.log("\n=== Configuration ===");
    console.log("Admin:", config.admin.toString());
    console.log("MILK Mint:", config.milkMint.toString());
    console.log("COW Mint:", config.cowMint.toString());
    console.log("Pool Token Account:", config.poolTokenAccount.toString());
    console.log("Start Time:", new Date(config.startTime.toNumber() * 1000).toISOString());
    console.log("Global Cows Count:", config.globalCowsCount.toNumber());
    console.log("Initial TVL:", config.initialTvl.toNumber() / 1_000_000, "MILK");

    // Get current TVL for calculations
    let currentTvl = 0;
    try {
      const poolBalance = await getAccount(provider.connection, config.poolTokenAccount);
      currentTvl = Number(poolBalance.amount);
      console.log("Current TVL:", currentTvl / 1_000_000, "MILK");
    } catch (error) {
      console.log("Could not fetch current TVL");
    }

    // Calculate dynamic cow price
    const globalCows = config.globalCowsCount.toNumber();
    let currentCowPrice = 6000; // base price
    if (globalCows > 0) {
      const ratio = globalCows / 1500;
      const powerTerm = Math.pow(ratio, 1.2);
      const multiplier = 1 + powerTerm;
      currentCowPrice = 6000 * multiplier;
    }
    
    console.log("Current Cow Price:", currentCowPrice.toFixed(2), "MILK");
    console.log("Price multiplier:", (currentCowPrice / 6000).toFixed(4) + "x");

    // Calculate dynamic reward rate
    let currentRewardRate = 10; // minimum rate
    if (globalCows > 0 && currentTvl > 0) {
      const tvlPerCow = currentTvl / globalCows;
      const normalizedRatio = tvlPerCow / 100_000_000_000; // 100k MILK normalization
      const denominator = 1 + (0.8 * normalizedRatio);
      const baseReward = 100_000 / denominator; // 100k MILK base
      
      // Greed multiplier
      const greedDecay = Math.exp(-globalCows / 250);
      const greedMultiplier = 1 + (5 * greedDecay);
      
      currentRewardRate = Math.max(baseReward * greedMultiplier, 10);
    }
    
    console.log("Current Reward Rate:", currentRewardRate.toFixed(2), "MILK/cow/day");
    console.log("TVL per Cow:", globalCows > 0 ? (currentTvl / globalCows / 1_000_000).toFixed(2) : "N/A", "MILK");
    
    // Calculate greed multiplier for display
    const greedDecay = Math.exp(-globalCows / 250);
    const greedMultiplier = 1 + (5 * greedDecay);
    console.log("Greed Multiplier:", greedMultiplier.toFixed(4) + "x");

    // Check pool balance (TVL)
    try {
      const poolBalance = await getAccount(provider.connection, config.poolTokenAccount);
      const poolBalanceInMilk = Number(poolBalance.amount) / 1_000_000;
      console.log("\n=== Pool Status (TVL) ===");
      console.log("Pool Balance:", poolBalanceInMilk, "MILK");
      console.log("Pool Token Account:", config.poolTokenAccount.toString());
      
      // Economic metrics
      if (globalCows > 0) {
        const tvlPerCow = poolBalanceInMilk / globalCows;
        console.log("TVL per Cow:", tvlPerCow.toFixed(2), "MILK");
        
        // ROI calculation
        const dailyRewardPerCow = currentRewardRate;
        const roiPercentage = (dailyRewardPerCow / currentCowPrice) * 100;
        const breakEvenDays = currentCowPrice / dailyRewardPerCow;
        
        console.log("Daily ROI:", roiPercentage.toFixed(2) + "%");
        console.log("Break-even time:", breakEvenDays.toFixed(1), "days");
      }
    } catch (error) {
      console.log("\n=== Pool Status (TVL) ===");
      console.log("❌ Could not fetch pool balance:", error.message);
    }

    // Check user's farm
    const [farmPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("farm"), wallet.publicKey.toBuffer()],
      program.programId
    );

    try {
      const farm = await program.account.farmAccount.fetch(farmPda);
      
      console.log("\n=== User Farm ===");
      console.log("Owner:", farm.owner.toString());
      console.log("Cows:", farm.cows.toNumber());
      console.log("Accumulated Rewards:", farm.accumulatedRewards.toNumber() / 1_000_000, "MILK");
      console.log("Last Update:", new Date(farm.lastUpdateTime.toNumber() * 1000).toISOString());
      
      // Show withdrawal penalty status
      if (farm.lastWithdrawTime && farm.lastWithdrawTime.toNumber() > 0) {
        const lastWithdraw = new Date(farm.lastWithdrawTime.toNumber() * 1000);
        const hoursSinceWithdraw = (Date.now() - lastWithdraw.getTime()) / (1000 * 60 * 60);
        const penaltyFree = hoursSinceWithdraw >= 24;
        
        console.log("Last Withdraw:", lastWithdraw.toISOString());
        console.log("Hours Since Last Withdraw:", hoursSinceWithdraw.toFixed(1));
        console.log("Next Withdraw Status:", penaltyFree ? "✅ Penalty-free" : `⚠️  50% penalty (${(24 - hoursSinceWithdraw).toFixed(1)}h remaining)`);
      } else {
        console.log("Withdrawal Status: ✅ First withdrawal will be penalty-free");
      }

      // Calculate pending rewards using stored rate
      const currentTime = Math.floor(Date.now() / 1000);
      const timeSinceUpdate = currentTime - farm.lastUpdateTime.toNumber();
      const storedRate = farm.lastRewardRate ? farm.lastRewardRate.toNumber() / 1_000_000 : currentRewardRate;
      const pendingRewards = (farm.cows.toNumber() * storedRate * timeSinceUpdate) / 86400; // per day to per second
      
      console.log("Estimated Pending Rewards:", pendingRewards.toFixed(6), "MILK");
      console.log("Stored Reward Rate:", storedRate.toFixed(2), "MILK/cow/day");
      console.log("Total Claimable:", ((farm.accumulatedRewards.toNumber() / 1_000_000) + pendingRewards).toFixed(6), "MILK");
      
    } catch (error) {
      console.log("\n=== User Farm ===");
      console.log("Farm not initialized yet");
    }

    // Check user's token balance
    try {
      // Try to find user's token account
      const tokenAccounts = await provider.connection.getTokenAccountsByOwner(
        wallet.publicKey,
        { mint: config.milkMint }
      );

      if (tokenAccounts.value.length > 0) {
        const tokenAccount = tokenAccounts.value[0].pubkey;
        const balance = await getAccount(provider.connection, tokenAccount);
        
        console.log("\n=== User Token Balance ===");
        console.log("Token Account:", tokenAccount.toString());
        console.log("Balance:", Number(balance.amount) / 1_000_000, "MILK");
      } else {
        console.log("\n=== User Token Balance ===");
        console.log("No MILK token account found");
      }
    } catch (error) {
      console.log("Error checking token balance:", error.message);
    }

  } catch (error) {
    console.error("Error fetching status:", error.message);
  }
}

main().catch((error) => {
  console.error("Status check failed:", error);
  process.exit(1);
});