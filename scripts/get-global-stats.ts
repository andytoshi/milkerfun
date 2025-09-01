import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Milkerfun } from "../target/types/milkerfun";
import { PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";

/**
 * Script to get global statistics
 * Shows total cows count and TVL (pool balance)
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

  console.log("=== MilkerFun Global Statistics ===");
  console.log("Program ID:", program.programId.toString());
  console.log("Cluster:", provider.connection.rpcEndpoint);

  try {
    // Get config PDA
    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    const config = await program.account.config.fetch(configPda);
    
    console.log("\n=== Global Metrics ===");
    
    // Get global stats using the new function
    const globalStats = await program.methods
      .getGlobalStats()
      .accountsPartial({
        config: configPda,
        poolTokenAccount: config.poolTokenAccount,
      })
      .view();

    const totalCows = globalStats.globalCowsCount.toString();
    const poolBalanceRaw = globalStats.poolBalanceMilk.toString();
    const poolBalanceMilk = Number(poolBalanceRaw) / 1_000_000;

    console.log(`🌍 Total Cows in Ecosystem: ${totalCows}`);
    console.log(`💰 Total Value Locked (TVL): ${poolBalanceMilk.toLocaleString()} MILK`);
    
    // Format TVL in different units for readability
    if (poolBalanceMilk >= 1_000_000) {
      console.log(`💰 TVL (formatted): ${(poolBalanceMilk / 1_000_000).toFixed(2)}M MILK`);
    } else if (poolBalanceMilk >= 1_000) {
      console.log(`💰 TVL (formatted): ${(poolBalanceMilk / 1_000).toFixed(2)}K MILK`);
    }

    // Calculate some interesting metrics
    if (Number(totalCows) > 0) {
      const avgMilkPerCow = poolBalanceMilk / Number(totalCows);
      console.log(`📊 Average MILK per Cow: ${avgMilkPerCow.toFixed(2)} MILK`);
    }
    console.log("Initial TVL:", config.initialTvl.toNumber() / 1_000_000, "MILK");

    // Get current TVL for dynamic calculations
    const globalCows = Number(globalStats.globalCowsCount.toString());

    // Calculate dynamic cow price: P(c) = 6,000 * (1 + (c / 1,500)^1.2)
    let currentCowPrice = 6000; // base price
    if (globalCows > 0) {
      const ratio = globalCows / 1500;
      const powerTerm = Math.pow(ratio, 1.2);
      const multiplier = 1 + powerTerm;
      currentCowPrice = 6000 * multiplier;
    }

    // Calculate dynamic reward rate: R = max(B / (1 + α * (TVL/C) / S), R_min) * G(C)
    let currentRewardRate = 10; // minimum rate
    if (globalCows > 0 && poolBalanceMilk > 0) {
      const tvlPerCow = poolBalanceMilk / globalCows;
      const normalizedRatio = tvlPerCow / 100_000; // 100k MILK normalization
      const denominator = 1 + (0.8 * normalizedRatio);
      const baseReward = 100_000 / denominator; // 100k MILK base
      
      // Greed accumulator: G(C) = 1 + 5 * e^(-C/250)
      const greedDecay = Math.exp(-globalCows / 250);
      const greedMultiplier = 1 + (5 * greedDecay);
      
      currentRewardRate = Math.max(baseReward * greedMultiplier, 10);
    }

    console.log("\n=== Current Game Economics ===");
    console.log(`🏷️  Current Cow Price: ${currentCowPrice.toFixed(2)} MILK`);
    console.log(`⚡ Current Reward Rate: ${currentRewardRate.toFixed(2)} MILK/cow/day`);
    console.log(`📈 Price Multiplier: ${(currentCowPrice / 6000).toFixed(4)}x`);
    console.log(`🚀 Greed Multiplier: ${globalCows > 0 ? (1 + 5 * Math.exp(-globalCows / 250)).toFixed(4) : '6.00'}x`);
    console.log(`💰 TVL per Cow: ${globalCows > 0 ? (poolBalanceMilk / globalCows).toFixed(2) : 'N/A'} MILK`);

    // Calculate ROI metrics
    if (currentRewardRate > 0 && currentCowPrice > 0) {
      const daysToBreakEven = currentCowPrice / currentRewardRate;
      
      console.log("\n=== ROI Analysis ===");
      console.log(`⏱️  Break-even time: ${daysToBreakEven.toFixed(2)} days`);
      console.log(`📈 Daily ROI: ${(currentRewardRate / currentCowPrice * 100).toFixed(2)}%`);
      console.log(`📈 Hourly ROI: ${(currentRewardRate / currentCowPrice / 24 * 100).toFixed(4)}%`);
    }

    console.log("\n=== Raw Data for Frontend ===");
    console.log(`Global Cows Count: ${totalCows}`);
    console.log(`Pool Balance (raw): ${poolBalanceRaw}`);
    console.log(`Pool Balance (MILK): ${poolBalanceMilk}`);
    console.log(`Pool Token Account: ${config.poolTokenAccount.toString()}`);

  } catch (error) {
    console.error("❌ Test failed:", error.message);
    if (error.logs) {
      error.logs.forEach(log => console.error(log));
    }
  }
}

main().catch(console.error);